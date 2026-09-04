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
        in
        {
          default = pkgs.mkShell {
            packages = with pkgs; [
              # Host commands invoked directly by repository tooling.
              git
              iproute2
              nodejs_24
              pnpm
              openssh
              podman
              procps
              python3
              util-linux
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
