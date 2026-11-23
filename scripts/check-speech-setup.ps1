# Run by the Windows installer on its last page. It checks, and installs nothing:
#   - a Python that Whisper supports (3.9 - 3.13, same range as whisper-installer.js)
#   - Whisper itself (the venv the setup wizard makes, WHISPER_COMMAND, or on PATH)
#   - the chosen model's weights (<model>.pt)
# The setup wizard in the app installs whatever is missing. Prints a few short
# ASCII lines (the installer shows them as-is) and always exits 0.
param(
  [Parameter(Mandatory = $true)][string]$DataDir
)

$ErrorActionPreference = 'SilentlyContinue'
$lines = New-Object System.Collections.Generic.List[string]

# Settings from an earlier install, if any (.env in the app-data folder).
$envFile = Join-Path $DataDir '.env'
$settings = @{}
if (Test-Path -LiteralPath $envFile) {
  foreach ($raw in Get-Content -LiteralPath $envFile) {
    $line = $raw.Trim()
    if (-not $line -or $line.StartsWith('#')) { continue }
    $eq = $line.IndexOf('=')
    if ($eq -lt 1) { continue }
    $value = $line.Substring($eq + 1).Trim()
    if ($value -match '^"([^"]*)"' -or $value -match "^'([^']*)'") { $value = $Matches[1] }
    elseif ($value.Contains(' #')) { $value = $value.Substring(0, $value.IndexOf(' #')).Trim() }
    $settings[$line.Substring(0, $eq).Trim()] = $value
  }
}

$provider = "$($settings['SPEECH_PROVIDER'])".Trim().ToLower()
if ($provider -eq 'azure') {
  $lines.Add('Speech: Azure (cloud), so no local Whisper is needed.')
  $lines -join "`r`n"
  exit 0
}

# ---- Python ------------------------------------------------------------
function Get-PyVersion([string]$exe, [string[]]$pre) {
  # No double quotes in the code: Windows PowerShell 5.1 drops them when
  # passing arguments to a program, which would break the Python line.
  $out = & $exe @pre -c 'import sys; print(''%d.%d|%s'' % (sys.version_info[0], sys.version_info[1], sys.executable))' 2>$null
  if ($LASTEXITCODE -ne 0 -or -not $out) { return $null }
  $parts = "$out".Trim().Split('|')
  if ($parts[1] -match 'WindowsApps') { return $null }   # Microsoft Store stub, not a real Python
  return $parts[0]
}
function Test-PyOk([string]$v) {
  if ($v -notmatch '^(\d+)\.(\d+)$') { return $false }
  $n = [int]$Matches[1] * 100 + [int]$Matches[2]
  return ($n -ge 309 -and $n -le 313)
}

$python = $null; $otherPython = $null
foreach ($v in '3.12', '3.11', '3.10', '3.13', '3.9') {
  if (Get-Command py -ErrorAction SilentlyContinue) {
    $found = Get-PyVersion 'py' @("-$v")
    if ($found) { $python = $found; break }
  }
}
if (-not $python) {
  foreach ($cmd in 'python', 'python3', 'py') {
    if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) { continue }
    $found = Get-PyVersion $cmd @()
    if (-not $found) { continue }
    if (Test-PyOk $found) { $python = $found; break } else { $otherPython = $found }
  }
}

# ---- Whisper -----------------------------------------------------------
$venvWhisper = Join-Path $DataDir '.venv-whisper\Scripts\whisper.exe'
$whisper = $null
if (Test-Path -LiteralPath $venvWhisper) {
  $whisper = 'installed'
} else {
  $cmd = "$($settings['WHISPER_COMMAND'])".Trim()
  $first = if ($cmd -match '^"([^"]+)"') { $Matches[1] } elseif ($cmd -match '^(\S+)') { $Matches[1] } else { '' }
  if ($first -and [System.IO.Path]::IsPathRooted($first) -and (Test-Path -LiteralPath $first)) { $whisper = 'installed' }
  elseif (Get-Command whisper -CommandType Application -ErrorAction SilentlyContinue) { $whisper = 'found on PATH' }
}

# ---- Model -------------------------------------------------------------
$model = "$($settings['WHISPER_MODEL'])".Trim()
$modelDirs = @((Join-Path $DataDir '.whisper-models'), (Join-Path $env:USERPROFILE '.cache\whisper'))
$customDir = "$($settings['WHISPER_MODEL_DIR'])".Trim()
if ($customDir -and [System.IO.Path]::IsPathRooted($customDir)) { $modelDirs = @($customDir) + $modelDirs }
$modelReady = $false
if ($model) {
  foreach ($d in $modelDirs) { if (Test-Path -LiteralPath (Join-Path $d "$model.pt")) { $modelReady = $true; break } }
}
$later = "$($settings['WHISPER_MODEL_DOWNLOAD'])".Trim().ToLower() -eq 'later'

# ---- Report ------------------------------------------------------------
$missing = $false
if ($python) { $lines.Add("[OK]  Python $python") }
elseif ($otherPython) { $lines.Add("[--]  Python $otherPython found, but Whisper needs 3.9 - 3.13"); $missing = $true }
elseif ($whisper) { $lines.Add('[--]  Python not found (not needed: Whisper is already installed)') }
else { $lines.Add('[--]  Python not found. Install Python 3.12 from python.org first.'); $missing = $true }

if ($whisper) { $lines.Add("[OK]  Whisper $whisper") }
else { $lines.Add('[--]  Whisper not installed'); $missing = $true }

if ($modelReady) { $lines.Add("[OK]  Model $model downloaded") }
elseif ($model -and $later) { $lines.Add("[--]  Model $model downloads on first use (your choice)") }
elseif ($model) { $lines.Add("[--]  Model $model not downloaded"); $missing = $true }
else { $lines.Add('[--]  No model yet: you pick one in setup'); $missing = $true }

$lines.Add('')
if ($missing) { $lines.Add('Setup installs the missing parts the first time you open Code.') }
else { $lines.Add('Local speech is ready.') }

$lines -join "`r`n"
exit 0
