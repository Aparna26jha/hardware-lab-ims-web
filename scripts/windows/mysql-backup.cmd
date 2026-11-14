@echo off
rem Full MySQL copy of one IMS database. Run nightly from Task Scheduler.
rem Usage: mysql-backup.cmd ims_dev D:\IMS_Backups\dev
rem The MySQL user and password are read from C:\IMS\mysql-backup.cnf, for example:
rem   [client]
rem   user=ims_app
rem   password=the-password
setlocal
set DB=%1
set OUT=%2
if "%DB%"=="" set DB=ims_dev
if "%OUT%"=="" set OUT=D:\IMS_Backups\%DB%
if not exist "%OUT%" mkdir "%OUT%"
for /f %%i in ('powershell -NoProfile -Command "Get-Date -Format yyyyMMdd_HHmmss"') do set STAMP=%%i
"C:\Program Files\MySQL\MySQL Server 8.4\bin\mysqldump.exe" --defaults-extra-file=C:\IMS\mysql-backup.cnf --single-transaction --routines --triggers %DB% > "%OUT%\%DB%_%STAMP%.sql"
if errorlevel 1 (
  echo Backup of %DB% failed.
  exit /b 1
)
rem Keep 30 days of copies.
forfiles /p "%OUT%" /m %DB%_*.sql /d -30 /c "cmd /c del @path" 2>nul
echo Backup saved: %OUT%\%DB%_%STAMP%.sql
