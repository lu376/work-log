@echo off
chcp 65001 >nul
cd /d "%~dp0"

set PYTHON=
for %%p in (python python3) do (
    where %%p >nul 2>&1
    if not errorlevel 1 (
        set PYTHON=%%p
        goto :found
    )
)

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
pause
exit /b 1

:found
echo ========================================
echo     周报生成工具
echo ========================================
echo.
echo 正在生成当前周周报...
echo.

%PYTHON% report.py %*

echo.
echo ========================================
echo 按任意键退出...
pause >nul
