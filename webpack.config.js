var path = require("path");
const CopyPlugin = require("copy-webpack-plugin");

module.exports = {
  entry: "./index.ts",
  target: "node",
  module: {
    rules: [
      {
        test: /\.ts$/,
        use: "ts-loader",
        exclude: /node_modules/
      }
    ]
  },
  resolve: {
    extensions: [ ".ts", ".js" ]
  },
  output: {
    path: path.join(__dirname, "build"),
    filename: "konnector.js"
  },
  plugins: [
    new CopyPlugin([
      { from: "manifest.konnector" },
      { from: "package.json" },
      { from: "README.md" },
      { from: "LICENSE" }
    ])
  ]
}
