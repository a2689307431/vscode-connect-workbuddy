@echo off
chcp 65001 >nul
title WorkBuddy Proxy :8799
cd /d "%~dp0"
node workbuddy-proxy.mjs --port 8799
echo.
echo [代理已退出] 按任意键关闭...
pause >nul
