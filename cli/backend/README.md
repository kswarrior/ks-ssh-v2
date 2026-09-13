# KS SSH backend (Rust)

Local UI: `cargo run -p ks-ssh -- --port 8080`
Relay (no open port): `cargo run -p ks-ssh -- --no-serve --token=`
Relay + local UI: `cargo run -p ks-ssh -- --token=`
Full build: `../rebuild.sh` → `../release/ks-ssh`
