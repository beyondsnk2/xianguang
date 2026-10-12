@echo off
chcp 65001 >nul
title 闲逛 sanWalk 启动器
cd /d "%~dp0"

echo ============================================
echo   闲逛 sanWalk 项目启动
echo ============================================

:: ========== 1. 检查 Node.js ==========
:: 注意：本脚本不使用带括号的多行 if 块——cmd 会把块内 echo 文本中的
:: 右括号当成块结束符，导致 pause / exit 无条件执行。一律用 goto 单行判断。
where node >nul 2>nul
if not errorlevel 1 goto :node_ok
if exist "C:\Program Files\nodejs\node.exe" set "PATH=C:\Program Files\nodejs;%PATH%"
where node >nul 2>nul
if not errorlevel 1 goto :node_ok
echo [错误] 未检测到 Node.js，请先安装：https://nodejs.org
echo [错误] 或把 Node.js 安装目录加入系统 PATH 环境变量
call :diag
pause
exit /b 1

:node_ok
echo [信息] Node.js 已就绪

:: ========== 2. 检查依赖 ==========
if exist "node_modules\.bin\vite.cmd" goto :deps_ok
echo [信息] 未检测到依赖，正在执行 npm install ...
call npm install
if errorlevel 1 goto :install_failed

:deps_ok
echo [信息] 依赖已就绪

:: ========== 3. 启动 Vite 开发服务器 ==========
echo [信息] 正在启动开发服务器 npm run dev ...
echo [提示] 默认地址 http://localhost:5173
echo [提示] 按 Ctrl+C 可停止服务器
echo ============================================

call npm run dev

echo.
echo [信息] 开发服务器已停止，按任意键关闭窗口。
pause
goto :eof

:install_failed
echo [错误] npm install 失败，请检查网络或 npm 配置
call :diag
pause
exit /b 1

:: ========== 诊断信息：出错时写入 start.log ==========
:diag
echo ===== start.log %DATE% %TIME% =====>> start.log
echo 目录=%CD%>> start.log
where node >> start.log 2>&1
node --version >> start.log 2>&1
echo 端口5173监听:>> start.log
netstat -ano | findstr :5173 >> start.log 2>&1
exit /b 0
