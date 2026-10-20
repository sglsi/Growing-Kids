@echo off
chcp 65001 >nul
echo ============================================
echo  GrowingKids dev: open TCP 3001 for LAN
echo  (needed for real-device debugging)
echo ============================================
echo.

net session >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Not running as administrator.
  echo Please right-click this file and choose
  echo "Run as administrator", then run again.
  echo.
  pause
  exit /b 1
)

echo Removing any previous rule (idempotent)...
netsh advfirewall firewall delete rule name="GrowingKids-Dev-3001" >nul 2>&1

echo Adding inbound allow rule for TCP 3001 ...
netsh advfirewall firewall add rule name="GrowingKids-Dev-3001" dir=in action=allow protocol=TCP localport=3001 profile=any
if errorlevel 1 (
  echo.
  echo [FAILED] Could not add the firewall rule.
  pause
  exit /b 1
)

echo.
echo [OK] TCP 3001 is now open on all profiles.
echo Phone can now reach http://192.168.3.242:3001
echo.
pause
