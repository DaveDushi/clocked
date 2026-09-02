# clocked for Linux

This x86-64 build targets current Omarchy/Arch Linux Wayland desktops.

Install the runtime dependencies and clocked for the current user:

```sh
omarchy pkg add gtk3 libayatana-appindicator libsecret libnotify libpulse wayland
./install.sh
~/.local/bin/clocked
```

The installer does not use root access. It installs the binary under
`~/.local/bin`, adds the application launcher and icons under
`~/.local/share`, and enables start-at-login under `~/.config/autostart`.

