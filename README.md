# emsg

## Installation and Execution

An emergency, quick-setup, no requirements messenger to use when you cannot access the internet.
First setup a folder on the server and upload the server binary, along with
the `static` and `templates` folder(All available in the release bundle).
To run it, you just need to upload the binary to the server and run:

```bash
PORT=4000 ./emsgkas
```

## Running as a Service

you can use the `msgkas.service` as an example to setup a systemd service. To do so, follow the steps below

1. Copy `emsgkas.service` to `/etc/systemd/system`
2. Edit the WorkingDirectory, Executable, and PORT(optional)
3. Run the following commands to enable and start the service

```bash
sudo systemctl enable emsgkas
sudo systemctl start emsgkas
```

## Running locally
Before running the application in a local environment, make sure to first
build the AES256 encryption wasm module with the following commands:

```bash
# Build the wasm module in static/
make encryption-wasm

# If not present, also copy the wasm loader from go stdlib
cp "$(go env GOROOT)/lib/wasm/wasm_exec.js" static/

```

## TODO

- [x] Scroll to bottom
- [x] HTTPS
- [x] WS ping pong
- [x] AES256 Encryption
- [ ] Local storage message history and message ids
- [ ] file upload
- [ ] Emojis
