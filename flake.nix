{
  description = "Reproducible host development environment for DSH plugins";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { nixpkgs, ... }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" ];
      forEachSystem = nixpkgs.lib.genAttrs systems;
    in
    {
      devShells = forEachSystem (system:
        let
          pkgs = import nixpkgs { inherit system; };
          python = pkgs.python3.withPackages (ps: with ps; [
            bleak
            dbus-fast
            paho-mqtt
            selenium
            websocket-client
          ]);
        in
        {
          default = pkgs.mkShell {
            packages = with pkgs; [
              # JavaScript/TypeScript toolchain. Harness-owned dependencies stay
              # in the isolated DSH development environment.
              nodejs_24
              pnpm_11
              typescript

              # Python compatibility environment for user-owned Workspace scripts.
              python

              # Host commands required by release tooling, scripts, and checks.
              bash
              bluez
              cacert
              coreutils
              curl
              direnv
              findutils
              gawk
              gcc
              git
              gnugrep
              gnused
              gnutar
              gnumake
              iproute2
              iputils
              jq
              less
              netcat-gnu
              openssh
              openssl
              podman
              procps
              pkg-config
              ripgrep
              rsync
              socat
              sqlite
              util-linux
              xz
              zstd
            ];

            env = {
              PIP_DISABLE_PIP_VERSION_CHECK = "1";
              PYTHONDONTWRITEBYTECODE = "1";
            };

            shellHook = ''
              export DSH_NIX_DEVELOP=1
            '';
          };
        });
    };
}
