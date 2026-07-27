; RECON installer -- Inno Setup 6.
; Built by installers\build_installer.ps1, which expects dist\RECON.exe to
; already exist (run build_exe.ps1 first).
;
; The one page that matters is the role page. Before it, whichever PC finished
; booting first declared itself the master and started its own database; two
; PCs powering up together each became a master and the shop ended up with two
; sets of records. The role is chosen here, once, and written to
; deployment.json where the app reads it.

#define AppName        "RECON"
#define AppVersion     "1.0.0"
#define AppPublisher   "Discount Auto Repair"
#define AppExe         "RECON.exe"
#define AppPort        "8787"
#define DiscoveryPort  "47823"

[Setup]
AppId={{7C4B1E92-2F63-4A7D-9B18-4C0E5A6D3F21}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher={#AppPublisher}
DefaultDirName={autopf}\{#AppName}
DefaultGroupName={#AppName}
UninstallDisplayName={#AppName}
UninstallDisplayIcon={app}\{#AppExe}
OutputDir=..\dist
OutputBaseFilename=RECON-Setup-{#AppVersion}
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
; Per-machine: the shop PC is shared, and a per-user install would give the
; morning and evening shifts separate copies pointed at separate databases.
PrivilegesRequired=admin
ArchitecturesInstallIn64BitMode=x64compatible
DisableProgramGroupPage=yes
SetupIconFile=..\static\favicon.ico

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; GroupDescription: "Shortcuts:"
Name: "startup";     Description: "Start {#AppName} automatically when Windows starts"; GroupDescription: "Startup:"

[Files]
Source: "..\dist\{#AppExe}"; DestDir: "{app}"; Flags: ignoreversion
; Extracted only long enough to run it; NeedsWebView2 decides whether it runs
; at all. Fetched by build_installer.ps1, not kept in the repo.
Source: "MicrosoftEdgeWebview2Setup.exe"; DestDir: "{tmp}"; Flags: deleteafterinstall

[Icons]
Name: "{group}\{#AppName}";              Filename: "{app}\{#AppExe}"
Name: "{group}\Uninstall {#AppName}";    Filename: "{uninstallexe}"
Name: "{autodesktop}\{#AppName}";        Filename: "{app}\{#AppExe}"; Tasks: desktopicon
Name: "{commonstartup}\{#AppName}";      Filename: "{app}\{#AppExe}"; Tasks: startup

[Run]
; WebView2 is what draws the window. Windows 11 has it; older Windows 10 may
; not, so bootstrap it before first launch rather than failing at runtime.
Filename: "{tmp}\MicrosoftEdgeWebview2Setup.exe"; Parameters: "/silent /install"; \
  StatusMsg: "Installing the Microsoft WebView2 runtime..."; \
  Check: NeedsWebView2; Flags: waituntilterminated

Filename: "{app}\{#AppExe}"; Description: "Start {#AppName} now"; Flags: nowait postinstall skipifsilent

[UninstallRun]
; Take the firewall holes back out. Without this an uninstalled app leaves
; two open ports behind it forever.
Filename: "netsh"; Parameters: "advfirewall firewall delete rule name=""RECON (app)"""; \
  Flags: runhidden; RunOnceId: "DelFwApp"
Filename: "netsh"; Parameters: "advfirewall firewall delete rule name=""RECON (discovery)"""; \
  Flags: runhidden; RunOnceId: "DelFwDisc"

[Code]
var
  RolePage: TInputOptionWizardPage;
  HostPage: TInputQueryWizardPage;

function NeedsWebView2: Boolean;
var
  Version: String;
begin
  { The Evergreen runtime registers its version under EdgeUpdate. Present and
    non-empty means we can skip the bootstrapper. }
  Result := not (
    RegQueryStringValue(HKLM, 'SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}', 'pv', Version)
    or RegQueryStringValue(HKLM, 'SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}', 'pv', Version)
  );
end;

procedure InitializeWizard;
begin
  RolePage := CreateInputOptionPage(wpSelectTasks,
    'What is this PC?',
    'RECON keeps all the shop''s records on one PC. Every other PC reads and writes to it over the network.',
    'Pick one. Get this wrong and you end up with two separate sets of records that never merge.' + #13#10 +
    'You can change it later from the RECON tray icon.',
    True, False);
  RolePage.Add('This is the main shop PC  --  it holds the records');
  RolePage.Add('This is a workstation  --  it reads the records from the main shop PC');
  RolePage.SelectedValueIndex := 0;

  HostPage := CreateInputQueryPage(RolePage.ID,
    'Where is the main shop PC?',
    'Leave this blank unless RECON cannot find it by itself.',
    'Workstations normally find the shop PC automatically. Fill this in only if that fails ' +
    '-- for example if the two PCs are on different subnets or the network blocks broadcasts.');
  HostPage.Add('Shop PC name or IP address (optional):', False);
end;

function ShouldSkipPage(PageID: Integer): Boolean;
begin
  { The host box only makes sense for a workstation. }
  Result := (PageID = HostPage.ID) and (RolePage.SelectedValueIndex = 0);
end;

function IsMaster: Boolean;
begin
  Result := RolePage.SelectedValueIndex = 0;
end;

procedure WriteDeploymentConfig;
var
  Dir, Host, Json: String;
begin
  Dir := ExpandConstant('{commonappdata}\RECON');
  ForceDirectories(Dir);

  if IsMaster then
    Json := '{' + #13#10 + '  "role": "master",' + #13#10 + '  "master_host": null' + #13#10 + '}' + #13#10
  else
  begin
    Host := Trim(HostPage.Values[0]);
    if Host = '' then
      Json := '{' + #13#10 + '  "role": "client",' + #13#10 + '  "master_host": null' + #13#10 + '}' + #13#10
    else
      Json := '{' + #13#10 + '  "role": "client",' + #13#10 + '  "master_host": "' + Host + '"' + #13#10 + '}' + #13#10;
  end;

  SaveStringToFile(Dir + '\deployment.json', Json, False);

  { The master serves every other PC, so network mode is on from the start --
    otherwise it binds loopback only and no workstation can reach it. }
  if IsMaster then
    SaveStringToFile(Dir + '\network_mode.flag', 'enabled', False);
end;

procedure GrantUsersWriteAccess;
var
  ResultCode: Integer;
begin
  { ProgramData subfolders are created admin-writable only. The database lives
    here and every shift needs to write to it, so widen it once at install. }
  Exec(ExpandConstant('{sys}\icacls.exe'),
       ExpandConstant('"{commonappdata}\RECON" /grant *S-1-5-32-545:(OI)(CI)M /T /C /Q'),
       '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
end;

procedure AddFirewallRules;
var
  ResultCode: Integer;
  Exe: String;
begin
  { Only the shop PC accepts connections; a workstation makes them, which
    needs no inbound rule. }
  if not IsMaster then
    Exit;
  Exe := ExpandConstant('{app}\{#AppExe}');
  Exec('netsh', 'advfirewall firewall delete rule name="RECON (app)"', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Exec('netsh', 'advfirewall firewall delete rule name="RECON (discovery)"', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Exec('netsh',
       'advfirewall firewall add rule name="RECON (app)" dir=in action=allow protocol=TCP localport={#AppPort} program="' + Exe + '" profile=private,domain',
       '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Exec('netsh',
       'advfirewall firewall add rule name="RECON (discovery)" dir=in action=allow protocol=UDP localport={#DiscoveryPort} program="' + Exe + '" profile=private,domain',
       '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then
  begin
    WriteDeploymentConfig;
    GrantUsersWriteAccess;
    AddFirewallRules;
  end;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  Dir: String;
begin
  if CurUninstallStep <> usPostUninstall then
    Exit;

  Dir := ExpandConstant('{commonappdata}\RECON');
  if not DirExists(Dir) then
    Exit;

  { A silent uninstall has nobody to answer a prompt -- asking anyway just
    hangs it forever. Keep the data, which is the safe default regardless. }
  if UninstallSilent then
    Exit;

  { Default to keeping the records. Someone uninstalling to reinstall a newer
    build should not lose the shop's history because they clicked Next. }
  if MsgBox('Also delete RECON''s database and backups?' + #13#10#13#10 +
            Dir + #13#10#13#10 +
            'Choose No to keep them (recommended -- reinstalling will pick them back up).',
            mbConfirmation, MB_YESNO or MB_DEFBUTTON2) = IDYES then
    DelTree(Dir, True, True, True);
end;
