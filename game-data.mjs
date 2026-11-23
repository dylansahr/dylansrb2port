// Compressed ZIP entry ranges in Sonic Team Junior's official 2.2.15 release.
export const releaseZip = "https://github.com/STJr/SRB2/releases/download/SRB2_release_2.2.15/SRB2-v2215-Full.zip";
export const releaseSize = 179033270;
export const gameDataPath = "/game-data/2.2.15/";
export const modelArchive = "models.bin";
export const gameData = {
  "srb2.pk3": {
    start: 110627220, end: 158133529, size: 50115266,
    sha256: "0c5025b70dbd83faea86e59fbe888250ea70d799fa3b8c2f82535d180a3ef5b5",
  },
  "zones.pk3": {
    start: 160607870, end: 179006660, size: 18503511,
    sha256: "2bc641793f339d2122ae97b71d23859d3802b726aea9dc9177c13ead3a95aae2",
  },
  "characters.pk3": {
    start: 4765545, end: 6531313, size: 2044315,
    sha256: "f787fac81736ddaf168472f44ef78be26f63a475b95723b8cc39bdaa5435222a",
  },
  "music.pk3": {
    start: 9578414, end: 109186989, size: 99639560,
    sha256: "42b481e04946089336a98ae25d8b6aee8007ec88f1b2fc9cd8315967b461b96f",
  },
  "models.dat": {
    start: 9577110, end: 9578374, size: 5576,
    sha256: "aa66b6f2bc856806251f0f18e78848a0b27bb768470a9d98b8fd18e7bfa9420f",
  },
  // The release ZIP begins with a contiguous set of local records for models/.
  [modelArchive]: {
    start: 0, end: 4765500, size: 4765501,
    sha256: "889e8fbb17ca1892c0117fbe08ff5f98ed540eb3e998b1fe929486b964efc7bb",
  },
};
