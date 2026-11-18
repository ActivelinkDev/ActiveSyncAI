<#
.SYNOPSIS
  Gera o certificado HTTPS interno do ActiveSyncAI.

.DESCRIPTION
  1. Cria uma autoridade de certificação (CA) própria, "ActiveSyncAI CA", válida 10 anos.
     A chave privada da CA é exportada (protegida por palavra-passe) e REMOVIDA do
     Windows: guardar o ficheiro ca-private.pfx fora do servidor (cofre/pen guardada).
  2. Cria o certificado do servidor, assinado pela CA, para os nomes/IPs indicados
     (válido 2 anos), e grava-o em <DataDir>\tls\server.pfx com uma palavra-passe aleatória.
  3. Acrescenta TLS_PFX e TLS_PFX_PASSPHRASE ao .env (a palavra-passe não é mostrada).
  4. Exporta a parte pública da CA (ca.cer) para instalar nos PCs que acedem
     ("Autoridades de Certificação de Raiz Fidedignas"), uma vez por PC ou por GPO.

  Nada disto vai para o git: fica em <DataDir>\tls e no .env.

.EXAMPLE
  .\create-cert.ps1 -BackendDir C:\ActiveSyncAI\backend -DataDir C:\ActiveSyncAI\data -DnsNames activesync,activesync.empresa.local -IpAddresses 192.0.2.20
.EXAMPLE
  # Só para testar neste PC
  .\create-cert.ps1 -BackendDir . -DataDir .\data -DnsNames localhost -IpAddresses 127.0.0.1
#>
param(
  [Parameter(Mandatory)] [string]   $BackendDir,
  [Parameter(Mandatory)] [string]   $DataDir,
  [Parameter(Mandatory)] [string[]] $DnsNames,
  [string[]] $IpAddresses = @(),
  [int] $ServerYears = 2
)
$ErrorActionPreference = 'Stop'

$BackendDir = (Resolve-Path $BackendDir).Path
$envFile = Join-Path $BackendDir '.env'
if (-not (Test-Path $envFile)) { throw ".env não encontrado em $BackendDir" }
if (Select-String -Path $envFile -Pattern '^\s*TLS_PFX\s*=' -Quiet) {
  throw "O .env já tem TLS_PFX. Para renovar, apagar as linhas TLS_PFX/TLS_PFX_PASSPHRASE primeiro."
}

New-Item -ItemType Directory -Force (Join-Path $DataDir 'tls') | Out-Null
$tlsDir = (Resolve-Path (Join-Path $DataDir 'tls')).Path

function New-RandomSecret([int]$bytes = 32) {
  $b = New-Object byte[] $bytes
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b)
  [Convert]::ToBase64String($b)
}

# --- 1. CA ---
$ca = New-SelfSignedCertificate -Subject 'CN=ActiveSyncAI CA' -FriendlyName 'ActiveSyncAI CA' `
  -KeyAlgorithm RSA -KeyLength 4096 -HashAlgorithm SHA256 -KeyExportPolicy Exportable `
  -KeyUsage CertSign, CRLSign, DigitalSignature -TextExtension @('2.5.29.19={critical}{text}ca=true&pathlength=0') `
  -NotAfter (Get-Date).AddYears(10) -CertStoreLocation 'Cert:\CurrentUser\My'

# --- 2. Servidor ---
$san = @()
$san += $DnsNames    | ForEach-Object { "DNS=$_" }
$san += $IpAddresses | ForEach-Object { "IPAddress=$_" }
$sanText = '2.5.29.17={text}' + ($san -join '&')
$server = New-SelfSignedCertificate -Subject "CN=$($DnsNames[0])" -FriendlyName 'ActiveSyncAI servidor' `
  -Signer $ca -KeyAlgorithm RSA -KeyLength 2048 -HashAlgorithm SHA256 -KeyExportPolicy Exportable `
  -KeyUsage DigitalSignature, KeyEncipherment -TextExtension @($sanText, '2.5.29.37={text}1.3.6.1.5.5.7.3.1') `
  -NotAfter (Get-Date).AddYears($ServerYears) -CertStoreLocation 'Cert:\CurrentUser\My'

$serverPass = New-RandomSecret
$serverPfx = Join-Path $tlsDir 'server.pfx'
Export-PfxCertificate -Cert $server -FilePath $serverPfx -Password (ConvertTo-SecureString $serverPass -AsPlainText -Force) -ChainOption BuildChain | Out-Null

# --- 4. Parte pública da CA ---
$caCer = Join-Path $tlsDir 'ca.cer'
Export-Certificate -Cert $ca -FilePath $caCer | Out-Null

# Chave privada da CA: exportar protegida e retirar do Windows.
$caPass = Read-Host -AsSecureString 'Palavra-passe para proteger a chave privada da CA (guardar no cofre)'
$caPfx = Join-Path $tlsDir 'ca-private.pfx'
Export-PfxCertificate -Cert $ca -FilePath $caPfx -Password $caPass | Out-Null
Remove-Item "Cert:\CurrentUser\My\$($ca.Thumbprint)" -DeleteKey
Remove-Item "Cert:\CurrentUser\My\$($server.Thumbprint)" -DeleteKey

# --- 3. .env ---
Add-Content -Path $envFile -Encoding utf8 -Value @(
  '',
  '# HTTPS (gerado por deploy/windows/create-cert.ps1)',
  "TLS_PFX=$serverPfx",
  "TLS_PFX_PASSPHRASE=$serverPass"
)

# Restringir a pasta tls ao utilizador atual, ao SYSTEM e aos administradores.
icacls $tlsDir /inheritance:r /grant:r "$($env:USERNAME):(OI)(CI)F" 'SYSTEM:(OI)(CI)F' 'Administrators:(OI)(CI)F' | Out-Null

Write-Host ''
Write-Host "Certificado do servidor: $serverPfx (válido até $($server.NotAfter.ToString('yyyy-MM-dd')))"
Write-Host "Nomes: $($san -join ', ')"
Write-Host "CA pública para instalar nos PCs: $caCer"
Write-Host "Chave privada da CA: $caPfx  -> MOVER para fora do servidor (cofre)."
Write-Host ''
Write-Host 'Em cada PC que acede (uma vez):'
Write-Host '  Import-Certificate -FilePath ca.cer -CertStoreLocation Cert:\LocalMachine\Root   (PowerShell como administrador)'
