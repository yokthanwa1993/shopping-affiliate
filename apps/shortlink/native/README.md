Native Ubuntu runtime for the four Shopee shortlink Electron instances.

Files:
- `run-shortlink.sh`: launches one account with KasmVNC + Electron directly on the host.
- `shortlink-native@.service`: systemd template; expects `/etc/shortlink/<account>.env`.

Expected host layout:
- `/home/yok/shortlink-native/electron`
- `/home/yok/shortlink-native/state/<account>`
- `/etc/shortlink/<account>.env`
