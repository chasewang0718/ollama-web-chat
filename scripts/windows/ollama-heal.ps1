param(
  [string]$HostUrl = "http://127.0.0.1:11434",
  [string]$VerifyModel = "gemma2:9b",
  [int]$VerifyTimeoutSec = 45
)

$ErrorActionPreference = "Stop"

function Test-OllamaHealth {
  param([string]$Url, [string]$Model)
  try {
    $ps = Invoke-RestMethod -Method Get -Uri "$Url/api/ps" -TimeoutSec 3
    $models = @($ps.models)
    $stopping = $models | Where-Object { "$($_.until)".ToLower().Contains("stopping") } | Select-Object -First 1
    if ($stopping) {
      return @{ ok = $false; reason = "stopping:$($stopping.name)" }
    }

    $showBody = @{ model = $Model } | ConvertTo-Json -Depth 3
    $null = Invoke-RestMethod -Method Post -Uri "$Url/api/show" -ContentType "application/json" -Body $showBody -TimeoutSec 3
    return @{ ok = $true; reason = "healthy" }
  }
  catch {
    return @{ ok = $false; reason = $_.Exception.Message }
  }
}

function Restart-Ollama {
  Write-Host "[heal] killing ollama processes..."
  taskkill /IM ollama.exe /F *> $null
  taskkill /IM "ollama app.exe" /F *> $null

  Write-Host "[heal] starting ollama serve..."
  Start-Process -FilePath "cmd.exe" -ArgumentList "/d /s /c set OLLAMA_MODELS=&& start \"\" ollama serve" -WindowStyle Hidden
}

$health = Test-OllamaHealth -Url $HostUrl -Model $VerifyModel
if ($health.ok) {
  Write-Host "[heal] already healthy."
  exit 0
}

Write-Host "[heal] unhealthy: $($health.reason)"
Restart-Ollama

$started = Get-Date
while (((Get-Date) - $started).TotalSeconds -lt $VerifyTimeoutSec) {
  Start-Sleep -Milliseconds 1200
  $health = Test-OllamaHealth -Url $HostUrl -Model $VerifyModel
  if ($health.ok) {
    Write-Host "[heal] recovered."
    exit 0
  }
}

Write-Host "[heal] recovery timeout: $($health.reason)"
exit 2

