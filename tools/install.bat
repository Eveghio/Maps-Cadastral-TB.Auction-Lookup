@echo off
rem ============================================================================================
rem  NAPR Lookup - install / update (Windows)
rem
rem  Where the newest extension ZIP is published: a web address (for example a GitHub release
rem  asset) or, for a test, a local file path such as C:\Users\Me\Downloads\napr_lookup_3_5.zip
rem ============================================================================================
set "NAPR_ZIP=https://github.com/Eveghio/Maps-Cadastral-TB.Auction-Lookup/releases/latest/download/napr_lookup.zip"
rem ============================================================================================
chcp 65001 >nul
set "NAPR_SELF=%~f0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$s=[IO.File]::ReadAllText($env:NAPR_SELF,[Text.Encoding]::UTF8); $i=$s.IndexOf('#'+'POWERSHELL'); $root=Join-Path $env:LOCALAPPDATA 'NaprLookup'; New-Item -ItemType Directory -Force -Path $root | Out-Null; $ps=Join-Path $root 'updater.ps1'; [IO.File]::WriteAllText($ps,$s.Substring($i).Replace('__ZIP_SOURCE__',$env:NAPR_ZIP),(New-Object Text.UTF8Encoding($true))); & $ps -Install"
exit /b
#POWERSHELL
# NAPR Lookup updater (written by install.bat to %LOCALAPPDATA%\NaprLookup\updater.ps1).
#   -Install    first install / immediate update; registers the automatic update; shows messages
#   -Quiet      scheduled run: no windows, only update.log
#   -Uninstall  removes the automatic update
param([switch]$Install, [switch]$Quiet, [switch]$Uninstall)

$ZipSource = '__ZIP_SOURCE__'

$ErrorActionPreference = 'Stop'
$AppName  = 'NAPR Lookup'
$Root     = Join-Path $env:LOCALAPPDATA 'NaprLookup'
$ExtDir   = Join-Path $Root 'extension'
$Self     = Join-Path $Root 'updater.ps1'
$Vbs      = Join-Path $Root 'update-hidden.vbs'
$LogFile  = Join-Path $Root 'update.log'
$TaskName = 'NaprLookup Updater'

function Log([string]$m) {
  try { Add-Content -LiteralPath $LogFile -Value ('{0:yyyy-MM-dd HH:mm:ss}  {1}' -f (Get-Date), $m) -Encoding UTF8 } catch { }
}

function Say([string]$m, [bool]$isError = $false) {
  if ($Quiet) { return }
  try {
    Add-Type -AssemblyName System.Windows.Forms
    $icon = if ($isError) { [System.Windows.Forms.MessageBoxIcon]::Error } else { [System.Windows.Forms.MessageBoxIcon]::Information }
    [System.Windows.Forms.MessageBox]::Show($m, $AppName, [System.Windows.Forms.MessageBoxButtons]::OK, $icon) | Out-Null
  } catch { Write-Host $m }
}

function Get-ManifestVersion([string]$dir) {
  $f = Join-Path $dir 'manifest.json'
  if (-not (Test-Path -LiteralPath $f)) { return $null }
  try { return (Get-Content -LiteralPath $f -Raw -Encoding UTF8 | ConvertFrom-Json).version } catch { return $null }
}

if ($Uninstall) {
  try { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue } catch { }
  Log 'automatic update removed'
  Say "ავტომატური განახლება გამოირთო.`n`nექსთენშენი წაშალე Chrome-ში (chrome://extensions), შემდეგ კი ეს საქაღალდე:`n$Root"
  exit 0
}

# ---------- download + unpack the newest version ----------
$tmp = Join-Path ([IO.Path]::GetTempPath()) ('napr_' + [guid]::NewGuid().ToString('N'))
$oldVer = Get-ManifestVersion $ExtDir
try {
  if ($ZipSource -like '*OWNER/REPO*') { throw "install.bat-ში ჯერ მიუთითე ZIP-ის მისამართი (NAPR_ZIP)." }
  New-Item -ItemType Directory -Force -Path $tmp | Out-Null
  $zip = Join-Path $tmp 'extension.zip'
  if ($ZipSource -match '^https?://') {
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    $ProgressPreference = 'SilentlyContinue'
    Invoke-WebRequest -Uri $ZipSource -OutFile $zip -UseBasicParsing
  } else {
    Copy-Item -LiteralPath $ZipSource -Destination $zip
  }
  $unz = Join-Path $tmp 'x'
  Expand-Archive -LiteralPath $zip -DestinationPath $unz -Force
  # the extension is the folder with the top-most manifest.json (the ZIP may or may not have a top folder)
  $manifest = Get-ChildItem -LiteralPath $unz -Recurse -Filter 'manifest.json' | Sort-Object { $_.FullName.Length } | Select-Object -First 1
  if (-not $manifest) { throw 'ZIP-ში manifest.json ვერ ვიპოვე - ეს ექსთენშენის ფაილი არ არის.' }
  $src = $manifest.DirectoryName
  $newVer = Get-ManifestVersion $src
  if (-not $newVer) { throw 'manifest.json-ში ვერსია ვერ წავიკითხე.' }

  if ($oldVer -eq $newVer -and -not $Install) {
    Log "up to date ($newVer)"
  } else {
    New-Item -ItemType Directory -Force -Path $ExtDir | Out-Null
    # replace everything, manifest.json LAST: the extension reloads itself when it sees a new version there
    Get-ChildItem -LiteralPath $ExtDir -Force | Where-Object { $_.Name -ne 'manifest.json' } | Remove-Item -Recurse -Force
    Get-ChildItem -LiteralPath $src -Force | Where-Object { $_.Name -ne 'manifest.json' } | ForEach-Object {
      Copy-Item -LiteralPath $_.FullName -Destination $ExtDir -Recurse -Force
    }
    Copy-Item -LiteralPath (Join-Path $src 'manifest.json') -Destination (Join-Path $ExtDir 'manifest.json') -Force
    Log "installed $newVer (was $(if ($oldVer) { $oldVer } else { 'nothing' }))"
  }
} catch {
  Log ('ERROR: ' + $_.Exception.Message)
  Say ("ვერ მოხერხდა:`n" + $_.Exception.Message + "`n`nდეტალები: $LogFile") $true
  exit 1
} finally {
  Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
}

if (-not $Install) { exit 0 }

# ---------- first install / manual run: automatic update + instructions ----------
$autoOk = $true
try {
  # hidden runner, so the scheduled update never flashes a window (UTF-16: works with any user name)
  $vbsText = 'CreateObject("WScript.Shell").Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ""' + $Self + '"" -Quiet", 0, False'
  [IO.File]::WriteAllText($Vbs, $vbsText, [Text.Encoding]::Unicode)
  $action   = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument ('"' + $Vbs + '"')
  $trigger  = New-ScheduledTaskTrigger -Daily -At '09:00'
  $trigger.Repetition = (New-ScheduledTaskTrigger -Once -At '09:00' -RepetitionInterval (New-TimeSpan -Hours 3) -RepetitionDuration (New-TimeSpan -Hours 23)).Repetition
  $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 10)
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Description 'Keeps the NAPR Lookup Chrome extension up to date' -Force | Out-Null
} catch {
  $autoOk = $false
  Log ('automatic update NOT registered: ' + $_.Exception.Message)
}
$autoText = if ($autoOk) { 'განახლება შემდეგ ავტომატურია (დღეში რამდენჯერმე).' } else { 'ავტომატური განახლება ვერ ჩაირთო - განახლებისთვის install.bat ხელახლა გაუშვი.' }

if ($oldVer) {
  Say "განახლდა: $oldVer → $newVer.`n`nChrome ახალ ვერსიას 10 წუთში თვითონ ჩატვირთავს (ან chrome://extensions-ზე დააჭირე Reload).`n`n$autoText"
} else {
  try { Set-Clipboard -Value $ExtDir } catch { }
  try { Start-Process 'chrome.exe' 'chrome://extensions' } catch { }
  Say ("დაყენდა ვერსია $newVer.`n`nბოლო ნაბიჯი Chrome-ში (მხოლოდ ერთხელ):`n" +
       "1. გაიხსნება chrome://extensions - მარჯვენა ზედა კუთხეში ჩართე `"Developer mode`".`n" +
       "2. დააჭირე `"Load unpacked`" და აირჩიე ეს საქაღალდე (მისამართი უკვე დაკოპირებულია - ჩასვი Ctrl+V-ით):`n$ExtDir`n`n" +
       "Edge / Opera / Brave-ში იგივეა: edge://extensions, opera://extensions ...`n`n$autoText")
}
exit 0
