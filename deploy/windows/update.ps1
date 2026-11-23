<#
.SYNOPSIS
  Atualiza o ActiveSyncAI instalado pelo install.ps1 para a última versão do branch.

.DESCRIPTION
  1. Mostra os commits novos e pede confirmação (nada muda se não houver).
  2. Para o serviço.
  3. git pull (só avanço rápido; recusa se houver alterações locais no código).
  4. npm ci + build do backend e da interface.
  5. Arranca o serviço e confirma /health. Se falhar, mostra o log e indica como voltar atrás.

  Não toca no .env, na pasta de dados nem na base de dados (as migrações aplicam-se
  sozinhas no arranque). Não correr durante o sync diário (AUTO_SYNC_TIME).

.EXAMPLE
  .\update.ps1
#>
param(
  [string] $InstallDir = 'C:\ActiveSyncAI',
  [string] $Branch     = 'main',
  [int]    $Port       = 3004,
  [switch] $Yes
)
$ErrorActionPreference = 'Stop'
$ServiceId  = 'ActiveSyncAI'
$AppDir     = Join-Path $InstallDir 'app'
$BackendDir = Join-Path $AppDir 'apps\backend'
$FrontDir   = Join-Path $AppDir 'apps\frontend'
$LogDir     = Join-Path $InstallDir 'logs'

function Invoke-Checked([string]$what, [scriptblock]$cmd) {
  & $cmd
  if ($LASTEXITCODE -ne 0) { throw "$what falhou (código $LASTEXITCODE)." }
}

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) { throw 'Correr numa consola PowerShell como administrador.' }
if (-not (Get-Service $ServiceId -ErrorAction SilentlyContinue)) { throw "Serviço $ServiceId não instalado: correr install.ps1." }

# 1. O que há de novo
Invoke-Checked 'git fetch' { git -C $AppDir fetch --quiet origin $Branch }
$dirty = git -C $AppDir status --porcelain --untracked-files=no
if ($dirty) { throw "Há alterações locais no código em $AppDir. Não se edita o código no servidor:`n$dirty" }
$before = (git -C $AppDir rev-parse HEAD).Trim()
$incoming = git -C $AppDir log --oneline "HEAD..origin/$Branch"
if (-not $incoming) { Write-Host "Já está na versão mais recente ($($before.Substring(0,7)))." -ForegroundColor Green; exit 0 }
Write-Host 'Commits novos:' -ForegroundColor Cyan
$incoming | ForEach-Object { Write-Host "  $_" }
if (-not $Yes) {
  $ok = Read-Host 'Atualizar agora? O serviço fica parado durante a compilação (s/n)'
  if ($ok -notmatch '^(s|sim|y|yes)$') { Write-Host 'Cancelado.'; exit 0 }
}

# 2–4
Write-Host 'A parar o serviço…' -ForegroundColor Cyan
Stop-Service $ServiceId
(Get-Service $ServiceId).WaitForStatus('Stopped', '00:00:45')

Invoke-Checked 'git pull' { git -C $AppDir pull --ff-only --quiet origin $Branch }
Push-Location $BackendDir
try { Invoke-Checked 'npm ci (backend)' { npm ci --no-audit --no-fund }; Invoke-Checked 'build (backend)' { npm run build } } finally { Pop-Location }
Push-Location $FrontDir
try { Invoke-Checked 'npm ci (interface)' { npm ci --no-audit --no-fund }; Invoke-Checked 'build (interface)' { npm run build -- --configuration production } } finally { Pop-Location }

# 5
Write-Host 'A arrancar…' -ForegroundColor Cyan
Start-Service $ServiceId
$healthy = $false
for ($i = 0; $i -lt 30 -and -not $healthy; $i++) {
  Start-Sleep -Seconds 2
  $out = curl.exe -sk --max-time 3 "https://localhost:$Port/health" 2>$null
  $healthy = ($out -match '"ok":\s*true')
}
$after = (git -C $AppDir rev-parse --short HEAD).Trim()
if (-not $healthy) {
  Write-Host 'O serviço não respondeu em /health. Últimas linhas do log:' -ForegroundColor Red
  Get-ChildItem $LogDir -Filter '*.log' | Sort-Object LastWriteTime -Descending | Select-Object -First 2 |
    ForEach-Object { Write-Host "--- $($_.Name)"; Get-Content $_.FullName -Tail 25 }
  Write-Host ''
  Write-Host "Para voltar à versão anterior ($($before.Substring(0,7))):" -ForegroundColor Yellow
  Write-Host "  git -C '$AppDir' checkout $before ; depois voltar a compilar e arrancar (ou correr este script com o código corrigido no GitHub)."
  exit 1
}
Write-Host "Atualizado: $($before.Substring(0,7)) → $after. https://localhost:$Port/health responde." -ForegroundColor Green
