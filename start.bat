@echo off
chcp 65001 >nul
title 闲逛 (xianguang) 启动器

:: 切换到批处理所在目录
cd /d "%~dp0"

echo ============================================
echo   闲逛 (xianguang) 项目启动
echo ============================================

:: 检查 Node.js 是否可用
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [错误] 未检测到 Node.js，请先安装 Node.js (https://nodejs.org)
    pause
    exit /b 1
)

:: 依赖缺失则安装
if not exist "node_modules\" (
    echo [信息] 未检测到依赖，正在执行 npm install ...
    call npm install
    if %errorlevel% neq 0 (
        echo [错误] npm install 失败，请检查网络或 npm 配置。
        pause
        exit /b 1
    )
) else (
    echo [信息] 依赖已存在，跳过 npm install。
)

:: 启动 Vite 开发服务器
echo [信息] 正在启动开发服务器 (npm run dev) ...
echo [提示] 默认地址: http://localhost:5173
echo [提示] 按 Ctrl+C 可停止服务器。
echo ============================================

call npm run dev
