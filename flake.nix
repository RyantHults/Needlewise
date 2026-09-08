{
  description = "Local development shell for Needlewise";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { self, nixpkgs }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin" ];
      forEachSystem = nixpkgs.lib.genAttrs systems;
    in {
      devShells = forEachSystem (system:
        let
          pkgs = import nixpkgs {
            inherit system;
            config.allowUnfreePredicate = pkg:
              builtins.elem (nixpkgs.lib.getName pkg) [ "ngrok" ];
          };
        in {
          default = pkgs.mkShell {
            packages = [
              pkgs.nodejs_22
              pkgs.pnpm
              pkgs.git
              pkgs.pkg-config
              pkgs.ngrok
            ];

            shellHook = ''
              # Corepack is provided by the Node.js package and pins the
              # package-manager version declared in package.json.
              corepack --version >/dev/null
              pnpm --version >/dev/null
            '';
          };
        });
    };
}
