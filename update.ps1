# V-Amber updater for Windows. Двойной клик на update.cmd запускает этот
# скрипт; он скачивает последний релиз с GitHub и накатывает поверх
# текущей папки, сохраняя .env и logs/.

$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $here

$repo = "Dmitrii-VO/V-Amber"
$api  = "https://api.github.com/repos/$repo/releases/latest"

function Say ($msg)  { Write-Host "==> $msg" -ForegroundColor Cyan }
function Warn ($msg) { Write-Host $msg -ForegroundColor Yellow }
function Fail ($msg) { Write-Host $msg -ForegroundColor Red; Read-Host "Нажмите Enter"; exit 1 }

function CurrentVersion {
  if (-not (Test-Path ".\package.json")) { return "?" }
  try {
    return (Get-Content -Raw .\package.json | ConvertFrom-Json).version
  } catch { return "?" }
}

$current = CurrentVersion
Say "Текущая версия V-Amber: $current"
Say "Узнаю последнюю версию из GitHub..."

try {
  $meta = Invoke-RestMethod -Uri $api -Headers @{ "User-Agent" = "V-Amber-updater" } -TimeoutSec 15
} catch {
  Fail "Не удалось запросить GitHub. Проверь интернет. ($($_.Exception.Message))"
}

$tag = $meta.tag_name
if (-not $tag) { Fail "Не удалось разобрать ответ GitHub." }
$version = $tag -replace '^v',''

if ($current -eq $version) {
  Say "Уже стоит последняя версия ($version). Обновлять нечего."
  Read-Host "Нажмите Enter"
  exit 0
}

Say "Доступна версия $version. Качаю..."
$tmp = Join-Path $env:TEMP ("v-amber-update-" + [Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $tmp -Force | Out-Null
$zipPath = Join-Path $tmp "v-amber.zip"
$zipUrl  = "https://github.com/$repo/archive/refs/tags/$tag.zip"

try {
  Invoke-WebRequest -Uri $zipUrl -OutFile $zipPath -UseBasicParsing -TimeoutSec 60
} catch {
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
  Fail "Не удалось скачать $zipUrl ($($_.Exception.Message))"
}

Say "Распаковываю..."
try {
  Expand-Archive -LiteralPath $zipPath -DestinationPath $tmp -Force
} catch {
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
  Fail "ZIP повреждён ($($_.Exception.Message))"
}

$newDir = Get-ChildItem $tmp -Directory | Where-Object { $_.Name -like "V-Amber-*" } | Select-Object -First 1
if (-not $newDir) {
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
  Fail "Не нашёл папку проекта в архиве."
}
if (-not (Test-Path (Join-Path $newDir.FullName "package.json"))) {
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
  Fail "В архиве нет package.json — отмена."
}

# Проверка, что V-Amber не запущен (порт 8080).
$portBusy = $false
try {
  $portBusy = [bool](Get-NetTCPConnection -LocalPort 8080 -State Listen -ErrorAction SilentlyContinue)
} catch { }
if ($portBusy) {
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
  Warn "На порту 8080 что-то запущено — скорее всего V-Amber работает."
  Warn "Остановите его (Ctrl+C в окне с npm start или закройте Docker-контейнер) и запустите update.cmd снова."
  Read-Host "Нажмите Enter"
  exit 1
}

Say "Накатываю файлы новой версии..."
# robocopy /MIR делает зеркальную копию, но мы хотим СОХРАНИТЬ .env, logs/,
# node_modules/, .DS_Store. /XD исключает каталоги в target, /XF — файлы.
$source = $newDir.FullName
$exitCode = (Start-Process -FilePath robocopy.exe `
  -ArgumentList @(
    "`"$source`"", "`"$here`"",
    "/MIR",
    "/XD", "`"$here\logs`"", "`"$here\node_modules`"", "`"$here\.git`"",
    "/XF", "`"$here\.env`"", "`"$here\.DS_Store`"",
    "/NFL", "/NDL", "/NJH", "/NJS", "/NC", "/NS", "/NP"
  ) -NoNewWindow -PassThru -Wait).ExitCode
# robocopy: коды 0-7 это успех/предупреждения, 8+ ошибка.
if ($exitCode -ge 8) {
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
  Fail "robocopy завершился с ошибкой (код $exitCode)."
}

Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue

Say "Устанавливаю npm-зависимости..."
$npmCmd = Get-Command npm -ErrorAction SilentlyContinue
if ($npmCmd) {
  & npm install --silent
} else {
  Warn "npm не найден в PATH. Установи Node.js (https://nodejs.org) и запусти 'npm install' в этой папке вручную."
}

$new = CurrentVersion
Say "Готово. Версия: $new"
Write-Host ""
Write-Host "Запустите V-Amber снова через 'npm start' в этой папке или через Docker."
Read-Host "Нажмите Enter, чтобы закрыть окно"
