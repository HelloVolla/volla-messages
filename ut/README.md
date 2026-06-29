# Volla Messages for Ubuntu Touch
Volla Messages [Clickable](https://clickable-ut.dev/en/latest/) packaging for Ubuntu Touch

## Download
You can download a pre-built click file from the [Releases](https://github.com/nimafanniasl/volla-messages-ut/releases/latest) page.

## Build Instructions
1. [Install Clickable](https://clickable-ut.dev/en/latest/install.html)
2. `clickable build --arch arm64 --skip-review`
3. `clickable install && clickable launch`

## Roadmap
- [x] Auto Light/Dark Mode
- [x] Fix Scaling on wayland (Calculate based on Unit-Size)
- [x] Disable CSD
- [x] Fix Maliit Keyboard*
- [ ] Use Correct writable-directories
- [ ] Fix Clipboard
- [ ] Use content-hub instead of a file-picker

*: There is a bug when using Maliit Keyboard with `Word Suggestion` Turned on.