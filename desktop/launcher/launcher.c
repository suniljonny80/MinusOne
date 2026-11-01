// MinusOne.exe: starts the portable MinusOne app from the folder this exe lives in.
// Build (cross-compile from any OS):
//   python -m ziglang cc -target x86_64-windows-gnu -O2 -s -municode -Wl,--subsystem,windows launcher.c minusone.rc \
//       -lshell32 -luser32 -o MinusOne.exe
#define WIN32_LEAN_AND_MEAN
#ifndef UNICODE
#define UNICODE
#endif
#ifndef _UNICODE
#define _UNICODE
#endif
#include <windows.h>
#include <shellapi.h>

#define BIG 4096

static int exists(const wchar_t *path) {
    return GetFileAttributesW(path) != INVALID_FILE_ATTRIBUTES;
}

int WINAPI wWinMain(HINSTANCE inst, HINSTANCE prev, PWSTR args, int show) {
    (void)inst; (void)prev; (void)args; (void)show;
    wchar_t dir[BIG], py[BIG], script[BIG], setup[BIG], cmd[BIG * 2];

    DWORD n = GetModuleFileNameW(NULL, dir, BIG);
    if (n == 0 || n >= BIG) return 1;
    for (int i = (int)n - 1; i >= 0; i--) {
        if (dir[i] == L'\\' || dir[i] == L'/') { dir[i + 1] = 0; break; }
    }

    lstrcpyW(py, dir);     lstrcatW(py, L"runtime\\pythonw.exe");
    lstrcpyW(script, dir); lstrcatW(script, L"app\\desktop.py");
    lstrcpyW(setup, dir);  lstrcatW(setup, L"Set up USB.bat");

    if (!exists(script)) {
        MessageBoxW(NULL, L"The 'app' folder is missing next to MinusOne.exe.\n\n"
                          L"Copy the whole MinusOne folder to the USB, not just the exe.",
                    L"MinusOne", MB_OK | MB_ICONERROR);
        return 1;
    }

    if (!exists(py)) {
        int r = MessageBoxW(NULL,
            L"MinusOne isn't set up on this USB yet.\n\n"
            L"Set it up now? It downloads about 2 GB, so use a PC with internet. "
            L"You only need to do this once.",
            L"MinusOne", MB_YESNO | MB_ICONINFORMATION);
        if (r == IDYES) ShellExecuteW(NULL, L"open", setup, NULL, dir, SW_SHOWNORMAL);
        return 0;
    }

    wsprintfW(cmd, L"\"%s\" \"%s\"", py, script);
    STARTUPINFOW si;
    PROCESS_INFORMATION pi;
    ZeroMemory(&si, sizeof si);
    si.cb = sizeof si;
    ZeroMemory(&pi, sizeof pi);
    if (!CreateProcessW(py, cmd, NULL, NULL, FALSE, 0, NULL, dir, &si, &pi)) {
        MessageBoxW(NULL, L"MinusOne couldn't start. Try running 'Set up USB.bat' again.",
                    L"MinusOne", MB_OK | MB_ICONERROR);
        return 1;
    }
    CloseHandle(pi.hThread);
    CloseHandle(pi.hProcess);
    return 0;
}
