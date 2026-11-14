@echo off
rem Starts the IMS from the folder this script is in and writes a log next to it.
rem Task Scheduler runs this "At startup" so the IMS keeps running after a restart.
cd /d "%~dp0..\.."
if not exist logs mkdir logs
"C:\Program Files\nodejs\node.exe" --env-file=.env src\server.js >> logs\ims.log 2>&1
