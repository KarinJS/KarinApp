module.exports = {
  root: true,
  extends: '@react-native',
  // scripts/build-native-git.ps1 unpacks libgit2/mbedTLS under build/, whose
  // JavaScript tooling is not part of this project (build/ is gitignored).
  ignorePatterns: ['build/'],
};
