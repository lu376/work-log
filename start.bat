@echo off
chcp 65001 >nul
cd /d "%~dp0"

:: 查找 Python
set PYTHON=
for %%p in (python python3) do (
    where %%p >nul 2>&1
    if not errorlevel 1 (
        set PYTHON=%%p
        goto :found
    )
)

:: 尝试常见安装路径
for %%d in (
    "C:\Users\%USERNAME%\AppData\Local\Programs\Python\Python312\python.exe"
    "C:\Users\%USERNAME%\AppData\Local\Programs\Python\Python311\python.exe"
    "C:\Users\%USERNAME%\AppData\Local\Programs\Python\Python310\python.exe"
    "C:\Python312\python.exe"
    "C:\Python311\python.exe"
) do (
    if exist %%d (
        set PYTHON=%%d
        goto :found
    )
)

echo [ERROR] 未找到 Python，请先安装 Python 3
echo         下载地址: https://www.python.org/downloads/
pause
exit /b 1

:found
echo ==============================================
echo     工作记录 Web 应用
echo ==============================================
echo.
echo 正在启动服务...
echo.

%PYTHON% app.py %*

echo.
pause
