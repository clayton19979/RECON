# -*- mode: python ; coding: utf-8 -*-
# Single-file RECON.exe. Built via installers\build_exe.ps1, which is the
# only supported entry point -- it keeps this spec and the venv in step.

a = Analysis(
    ['app\\tray_app.py'],
    pathex=[],
    binaries=[],
    datas=[('static', 'static')],
    # pywebview loads its Windows backend lazily through pythonnet, so
    # PyInstaller's static analysis never sees these and would ship an exe
    # that dies on the first window with "no available GUI backend".
    hiddenimports=[
        'webview.platforms.edgechromium',
        'webview.platforms.winforms',
        'clr',
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    exclude_binaries=False,
    name='RECON',
    icon='static\\favicon.ico',
    version='version_info.txt',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
