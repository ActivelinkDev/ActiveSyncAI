<#
.SYNOPSIS
  Instala (ou repara) o ActiveSyncAI como serviço Windows, com uma conta de domínio própria.

.DESCRIPTION
  Pode correr-se várias vezes: cada passo só faz o que falta. Para quando falta algo
  que só uma pessoa pode fazer (preencher o .env, gerar o certificado) e diz o que fazer.

    1. Verificações: administrador, Node 24, git, módulo ActiveDirectory.
    2. Pastas <InstallDir>\{app,data,logs,service}.
    3. Código: clona o repositório (ou só confirma que já lá está). Para atualizar: update.ps1.
    4. Compila o backend e a interface.
    5. .env: cria a partir do .env.example e para, se ainda não existir.
    6. HTTPS: para, se o .env ainda não tiver TLS_PFX (correr create-cert.ps1).
    7. Teste à base de dados (npm run db:check).
    8. Conta do serviço: utilizador de domínio criado por um administrador (o script só
       confirma que existe e pede a palavra-passe uma vez); direito "iniciar sessão como
       serviço"; sem sessão local nem RDP (salvo -AllowInteractiveLogon).
    9. Permissões: só administradores, SYSTEM e a conta do serviço entram em <InstallDir>;
       o .env e a pasta tls só são lidos pela conta do serviço.
   10. Serviço WinSW (arranque automático, reinício em falha, logs rodados).
   11. Firewall: porta só para as redes indicadas.
   12. Arranca e confirma /health.

  O agendamento (AUTO_SYNC_ENABLED) e as campanhas (CAMPAIGN_TICKER_ENABLED) não são
  ligados aqui: só depois da 1.ª execução à mão, verificada.

.EXAMPLE
  .\install.ps1 -SqlServiceName 'MSSQL$INSTANCIA' -AllowedRemote 192.0.2.0/24
#>
param(
  [string]   $InstallDir     = 'C:\ActiveSyncAI',
  [string]   $RepoUrl        = 'https://github.com/ActivelinkDev/ActiveSyncAI.git',
  [string]   $Branch         = 'main',
  [string]   $ServiceUser    = 'svc-activesync',
  [int]      $Port           = 3004,
  # Quem pode chegar à porta. 'LocalSubnet' = a rede do próprio servidor.
  [string[]] $AllowedRemote  = @('LocalSubnet'),
  # Serviço do SQL Server de que este depende (ex.: MSSQL$INSTANCIA). Vazio = sem dependência.
  [string]   $SqlServiceName = '',
  [string]   $WinSwUrl       = 'https://github.com/winsw/winsw/releases/download/v2.12.0/WinSW-x64.exe',
  [int]      $NodeMajor      = 24,
  # Por omissão a conta do serviço não pode iniciar sessão local nem por RDP.
  [switch]   $AllowInteractiveLogon
)
$ErrorActionPreference = 'Stop'
$ServiceId = 'ActiveSyncAI'

# Grupos por SID (não dependem da língua do Windows).
$SID_ADMINS = '*S-1-5-32-544'
$SID_SYSTEM = '*S-1-5-18'

function Write-Step($n, $text) { Write-Host ''; Write-Host "[$n] $text" -ForegroundColor Cyan }
function Write-Ok($text)        { Write-Host "    OK  $text" -ForegroundColor Green }
function Write-Todo($text)      { Write-Host "    >>  $text" -ForegroundColor Yellow }
function Stop-Here($text)       { Write-Host ''; Write-Host $text -ForegroundColor Yellow; exit 2 }

function Invoke-Checked([string]$what, [scriptblock]$cmd) {
  & $cmd
  if ($LASTEXITCODE -ne 0) { throw "$what falhou (código $LASTEXITCODE)." }
}

function Get-EnvValue([string]$file, [string]$name) {
  $line = Select-String -Path $file -Pattern "^\s*$name\s*=(.*)$" | Select-Object -Last 1
  if ($line) { return $line.Matches[0].Groups[1].Value.Trim() }
  return ''
}

# Acrescenta um SID a um direito de utilizador da política local (secedit).
function Add-UserRight([string]$right, [string]$sid) {
  $tmp = Join-Path $env:TEMP ("asai-secedit-" + [guid]::NewGuid())
  New-Item -ItemType Directory $tmp | Out-Null
  try {
    $cfg = Join-Path $tmp 'cur.inf'
    Invoke-Checked 'secedit /export' { secedit /export /cfg $cfg /areas USER_RIGHTS /quiet | Out-Null }
    $line = (Get-Content $cfg) | Where-Object { $_ -match "^$right\s*=" } | Select-Object -First 1
    $current = @()
    if ($line) { $current = ($line -split '=', 2)[1].Split(',') | ForEach-Object { $_.Trim() } | Where-Object { $_ } }
    if ($current -contains "*$sid") { return $false }
    $new = @($current + "*$sid") -join ','
    $inf = Join-Path $tmp 'new.inf'
    @('[Unicode]', 'Unicode=yes', '[Version]', 'signature="$CHICAGO$"', 'Revision=1', '[Privilege Rights]', "$right = $new") |
      Set-Content -Path $inf -Encoding Unicode
    Invoke-Checked "secedit /configure ($right)" { secedit /configure /db (Join-Path $tmp 'x.sdb') /cfg $inf /areas USER_RIGHTS /quiet | Out-Null }
    return $true
  } finally { Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue }
}

function Test-UserRight([string]$right, [string]$sid) {
  $tmp = Join-Path $env:TEMP ("asai-secedit-" + [guid]::NewGuid() + '.inf')
  try {
    secedit /export /cfg $tmp /areas USER_RIGHTS /quiet | Out-Null
    $line = (Get-Content $tmp) | Where-Object { $_ -match "^$right\s*=" } | Select-Object -First 1
    return [bool]($line -and ($line -split '=', 2)[1] -match [regex]::Escape("*$sid"))
  } finally { Remove-Item $tmp -Force -ErrorAction SilentlyContinue }
}

# ---------------------------------------------------------------- 1
Write-Step 1 'Verificações'
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) { throw 'Correr numa consola PowerShell como administrador.' }
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { throw "Node.js não encontrado. Instalar o Node $NodeMajor LTS." }
$nodeVersion = (& node --version).Trim()
if ($nodeVersion -notmatch "^v$NodeMajor\.") { throw "Node $nodeVersion encontrado; o projeto usa o Node $NodeMajor (ver .nvmrc)." }
if (-not (Get-Command git -ErrorAction SilentlyContinue)) { throw 'git não encontrado.' }
Import-Module ActiveDirectory -ErrorAction Stop
$domain = Get-ADDomain
Write-Ok "Node $nodeVersion · git · domínio $($domain.NetBIOSName)"

# ---------------------------------------------------------------- 2
Write-Step 2 "Pastas em $InstallDir"
$AppDir     = Join-Path $InstallDir 'app'
$DataDir    = Join-Path $InstallDir 'data'
$LogDir     = Join-Path $InstallDir 'logs'
$SvcDir     = Join-Path $InstallDir 'service'
$BackendDir = Join-Path $AppDir 'apps\backend'
$FrontDir   = Join-Path $AppDir 'apps\frontend'
foreach ($d in $InstallDir, $DataDir, $LogDir, $SvcDir) { New-Item -ItemType Directory -Force $d | Out-Null }
Write-Ok 'app, data, logs, service'

# ---------------------------------------------------------------- 3
Write-Step 3 'Código'
if (-not (Test-Path (Join-Path $AppDir '.git'))) {
  if ((Get-ChildItem $AppDir -Force -ErrorAction SilentlyContinue | Measure-Object).Count -gt 0) {
    throw "$AppDir existe e não é um repositório git. Esvaziar ou indicar outro -InstallDir."
  }
  Invoke-Checked 'git clone' { git clone --branch $Branch $RepoUrl $AppDir }
  Write-Ok "clonado ($Branch)"
} else {
  Write-Ok "já existe ($((git -C $AppDir rev-parse --abbrev-ref HEAD).Trim()) @ $((git -C $AppDir rev-parse --short HEAD).Trim())). Para atualizar: update.ps1"
}

# ---------------------------------------------------------------- 4
Write-Step 4 'Compilar backend e interface'
Push-Location $BackendDir
try { Invoke-Checked 'npm ci (backend)' { npm ci --no-audit --no-fund }; Invoke-Checked 'build (backend)' { npm run build } } finally { Pop-Location }
Push-Location $FrontDir
try { Invoke-Checked 'npm ci (interface)' { npm ci --no-audit --no-fund }; Invoke-Checked 'build (interface)' { npm run build -- --configuration production } } finally { Pop-Location }
Write-Ok 'compilados'

# ---------------------------------------------------------------- 5
Write-Step 5 '.env'
$EnvFile = Join-Path $BackendDir '.env'
if (-not (Test-Path $EnvFile)) {
  Copy-Item (Join-Path $BackendDir '.env.example') $EnvFile
  icacls $EnvFile /inheritance:r /grant:r "${SID_ADMINS}:F" "${SID_SYSTEM}:F" | Out-Null
  Stop-Here @"
Criado $EnvFile a partir do .env.example (só administradores o leem).
Preencher (ver vault: Configuração e credenciais):
  DATA_DIR=$DataDir
  MSSQL_SERVER=localhost, MSSQL_INSTANCE, MSSQL_DATABASE, MSSQL_USER, MSSQL_PASSWORD
  SUPRIDES_*, SHOPIFY_*, OPENAI_API_KEY, SMTP_*, ALERT_*
  Deixar AUTO_SYNC_ENABLED=0 e CAMPAIGN_TICKER_ENABLED=0.
Depois voltar a correr este script.
"@
}
$dataDirEnv = Get-EnvValue $EnvFile 'DATA_DIR'
if (-not $dataDirEnv) { Stop-Here "Falta DATA_DIR no .env (sugestão: DATA_DIR=$DataDir)." }
if ((Get-EnvValue $EnvFile 'AUTO_SYNC_ENABLED') -match '^(1|true)$') { Write-Todo 'AUTO_SYNC_ENABLED está ligado: confirmar que o PC de desenvolvimento já não sincroniza.' }
Write-Ok "DATA_DIR=$dataDirEnv"

# ---------------------------------------------------------------- 6
Write-Step 6 'HTTPS'
$pfx = Get-EnvValue $EnvFile 'TLS_PFX'
if (-not $pfx) {
  $certScript = Join-Path $PSScriptRoot 'create-cert.ps1'
  Stop-Here @"
Falta o certificado. Correr (pede a palavra-passe para proteger a chave da CA):
  & '$certScript' -BackendDir '$BackendDir' -DataDir '$dataDirEnv' -DnsNames $($env:COMPUTERNAME.ToLower()),$($env:COMPUTERNAME.ToLower()).$($domain.DNSRoot) -IpAddresses <IP do servidor>
Depois voltar a correr este script.
"@
}
if (-not (Test-Path $pfx)) { throw "TLS_PFX aponta para $pfx, que não existe." }
Write-Ok $pfx

# ---------------------------------------------------------------- 7
Write-Step 7 'Base de dados'
Push-Location $BackendDir
try { Invoke-Checked 'npm run db:check' { npm run db:check --silent } } finally { Pop-Location }
Write-Ok 'ligação e isolamento confirmados'

# ---------------------------------------------------------------- 8
Write-Step 8 "Conta do serviço ($($domain.NetBIOSName)\$ServiceUser)"
# A conta é criada por um administrador no AD (este script não cria contas nem muda palavras-passe).
$user = Get-ADUser -Filter "SamAccountName -eq '$ServiceUser'" -Properties MemberOf, Enabled -ErrorAction SilentlyContinue
if (-not $user) {
  Stop-Here @"
A conta $($domain.NetBIOSName)\$ServiceUser não existe. Criá-la no AD (Utilizadores e Computadores do AD):
  - só no grupo Domain Users (sem administração);
  - "A palavra-passe nunca expira" e "O utilizador não pode alterar a palavra-passe";
  - palavra-passe guardada no cofre (é pedida a seguir, uma vez).
Depois voltar a correr este script (ou indicar outra conta com -ServiceUser).
"@
}
if (-not $user.Enabled) { throw "A conta $ServiceUser está desativada no AD." }
if ($user.MemberOf.Count -gt 0) { Write-Todo "A conta pertence a grupos além de Domain Users: $($user.MemberOf -join '; '). Retirar se não forem precisos." }
$userSid = $user.SID.Value
$cred = Get-Credential -UserName "$($domain.NetBIOSName)\$ServiceUser" -Message 'Palavra-passe da conta do serviço (só para a associar ao serviço; não fica gravada em ficheiro)'
if (-not $cred) { throw 'Cancelado.' }
# Confirmar a palavra-passe antes de a dar ao serviço.
Add-Type -AssemblyName System.DirectoryServices.AccountManagement
$ctx = New-Object System.DirectoryServices.AccountManagement.PrincipalContext('Domain', $domain.DNSRoot)
if (-not $ctx.ValidateCredentials($ServiceUser, $cred.GetNetworkCredential().Password)) { throw 'Palavra-passe errada para a conta do serviço.' }
Write-Ok 'conta e palavra-passe confirmadas'
if (Add-UserRight 'SeServiceLogonRight' $userSid) { Write-Ok 'direito "iniciar sessão como serviço" dado' }
if (-not $AllowInteractiveLogon) {
  foreach ($deny in 'SeDenyInteractiveLogonRight', 'SeDenyRemoteInteractiveLogonRight') { [void](Add-UserRight $deny $userSid) }
}
gpupdate /target:computer /force | Out-Null
if (-not (Test-UserRight 'SeServiceLogonRight' $userSid)) {
  Write-Todo 'A política de grupo dos controladores de domínio retirou o direito "Iniciar sessão como serviço".'
  Write-Todo "Acrescentar $($domain.NetBIOSName)\$ServiceUser em: GPMC > Default Domain Controllers Policy > Configuração do Computador > Políticas > Definições do Windows > Definições de Segurança > Políticas Locais > Atribuição de Direitos de Utilizador > Iniciar sessão como serviço. Depois voltar a correr este script."
  throw 'Sem o direito de iniciar sessão como serviço, o serviço não arranca.'
}
if (-not $AllowInteractiveLogon -and -not (Test-UserRight 'SeDenyInteractiveLogonRight' $userSid)) { Write-Todo 'Não foi possível negar a sessão local à conta (a política de grupo sobrepôs-se). Não impede o funcionamento.' }
Write-Ok 'direitos confirmados'

# ---------------------------------------------------------------- 9
Write-Step 9 'Permissões'
$acct = "*$userSid"
icacls $InstallDir /inheritance:r /grant:r "${SID_ADMINS}:(OI)(CI)F" "${SID_SYSTEM}:(OI)(CI)F" | Out-Null
icacls $AppDir  /grant:r "${acct}:(OI)(CI)RX" | Out-Null
icacls $SvcDir  /grant:r "${acct}:(OI)(CI)RX" | Out-Null
icacls $LogDir  /grant:r "${acct}:(OI)(CI)M"  | Out-Null
icacls $dataDirEnv /grant:r "${acct}:(OI)(CI)M" | Out-Null
icacls $EnvFile /inheritance:r /grant:r "${SID_ADMINS}:F" "${SID_SYSTEM}:F" "${acct}:R" | Out-Null
$tlsDir = Split-Path $pfx -Parent
icacls $tlsDir /grant:r "${acct}:(OI)(CI)R" | Out-Null
$caPrivate = Join-Path $tlsDir 'ca-private.pfx'
if (Test-Path $caPrivate) {
  icacls $caPrivate /inheritance:r /grant:r "${SID_ADMINS}:F" | Out-Null
  Write-Todo "A chave privada da CA ainda está no servidor: $caPrivate. Mover para o cofre."
}
Write-Ok 'só administradores, SYSTEM e a conta do serviço'

# ---------------------------------------------------------------- 10
Write-Step 10 'Serviço'
$winsw = Join-Path $SvcDir "$ServiceId.exe"
if (-not (Test-Path $winsw)) {
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  Invoke-WebRequest -Uri $WinSwUrl -OutFile $winsw -UseBasicParsing
  $hash = (Get-FileHash $winsw -Algorithm SHA256).Hash
  Write-Todo "WinSW descarregado. SHA256 = $hash"
  Write-Todo "Comparar com a página da versão em github.com/winsw/winsw/releases antes de continuar."
  $ok = Read-Host 'O SHA256 confere? (s/n)'
  if ($ok -notmatch '^(s|sim|y|yes)$') { Remove-Item $winsw -Force; throw 'WinSW apagado: o SHA256 não foi confirmado.' }
}
$depends = ''
if ($SqlServiceName) {
  if (-not (Get-Service -Name $SqlServiceName -ErrorAction SilentlyContinue)) { throw "Serviço SQL '$SqlServiceName' não encontrado." }
  $depends = "<depend>$SqlServiceName</depend>"
}
$xml = (Get-Content (Join-Path $PSScriptRoot 'activesyncai.xml') -Raw -Encoding UTF8).
  Replace('{{NODE_EXE}}', $node.Source).Replace('{{BACKEND_DIR}}', $BackendDir).
  Replace('{{LOG_DIR}}', $LogDir).Replace('{{DEPENDS}}', $depends)
$xmlPath = Join-Path $SvcDir "$ServiceId.xml"
$existing = Get-Service -Name $ServiceId -ErrorAction SilentlyContinue
if ($existing -and $existing.Status -ne 'Stopped') { Stop-Service $ServiceId; (Get-Service $ServiceId).WaitForStatus('Stopped', '00:00:45') }
[IO.File]::WriteAllText($xmlPath, $xml, (New-Object Text.UTF8Encoding $false))
if ($existing) {
  Invoke-Checked 'WinSW refresh' { & $winsw refresh }   # WinSW 2.x lê o .xml com o mesmo nome do .exe
  Write-Ok 'configuração atualizada'
} else {
  Invoke-Checked 'WinSW install' { & $winsw install }
  Write-Ok 'instalado'
}
$svc = Get-CimInstance Win32_Service -Filter "Name='$ServiceId'"
$r = Invoke-CimMethod -InputObject $svc -MethodName Change -Arguments @{ StartName = "$($domain.NetBIOSName)\$ServiceUser"; StartPassword = $cred.GetNetworkCredential().Password }
if ($r.ReturnValue -ne 0) { throw "Não foi possível definir a conta do serviço (código $($r.ReturnValue))." }
$cred = $null
Write-Ok "corre como $($domain.NetBIOSName)\$ServiceUser"

# ---------------------------------------------------------------- 11
Write-Step 11 'Firewall'
$ruleName = "$ServiceId-HTTPS"
Get-NetFirewallRule -Name $ruleName -ErrorAction SilentlyContinue | Remove-NetFirewallRule
New-NetFirewallRule -Name $ruleName -DisplayName "ActiveSyncAI (HTTPS $Port)" -Direction Inbound -Protocol TCP `
  -LocalPort $Port -RemoteAddress $AllowedRemote -Action Allow -Profile Domain, Private | Out-Null
Write-Ok "porta $Port só para: $($AllowedRemote -join ', ')"

# ---------------------------------------------------------------- 12
Write-Step 12 'Arranque'
Start-Service $ServiceId
$healthy = $false
for ($i = 0; $i -lt 30 -and -not $healthy; $i++) {
  Start-Sleep -Seconds 2
  $out = curl.exe -sk --max-time 3 "https://localhost:$Port/health" 2>$null
  $healthy = ($out -match '"ok":\s*true')
}
if (-not $healthy) {
  Write-Host ''
  Write-Host 'O serviço não respondeu em /health. Últimas linhas do log:' -ForegroundColor Red
  Get-ChildItem $LogDir -Filter '*.log' | Sort-Object LastWriteTime -Descending | Select-Object -First 2 |
    ForEach-Object { Write-Host "--- $($_.Name)"; Get-Content $_.FullName -Tail 25 }
  exit 1
}
Write-Ok "https://localhost:$Port/health responde"

Write-Host ''
Write-Host 'Instalação concluída.' -ForegroundColor Green
Write-Host 'Próximos passos (à mão):'
Write-Host "  1. Conta da interface, se ainda não houver:  cd '$BackendDir'; npm run auth:set-password"
Write-Host "  2. Credenciais cifradas:                      cd '$BackendDir'; npm run secrets:init; Restart-Service $ServiceId"
Write-Host "  3. Instalar o ca.cer ($tlsDir\ca.cer) nos PCs que acedem."
Write-Host '  4. 1.ª execução à mão + verificação; só depois AUTO_SYNC_ENABLED=1 e CAMPAIGN_TICKER_ENABLED=1 no .env e reiniciar.'
