Set shell = CreateObject("WScript.Shell")
q = Chr(34)
node = "C:\Users\henri\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
server = "C:\Users\henri\Dropbox\My PC (LAPTOP-K8G7UM1T)\Documents\SISTEMAS DE GLOSA PMGU\server.js"
shell.Run "cmd.exe /c " & q & q & node & q & " " & q & server & q & " > NUL 2>&1" & q, 0, False
