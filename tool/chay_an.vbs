Set sh = CreateObject("Wscript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
folder = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = folder
pythonExe = WScript.Arguments(0)
sh.Run """" & pythonExe & """ """ & folder & "\mo.py""", 0, False
