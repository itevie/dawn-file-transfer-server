const config = {
  port: "8001",
  dataPath: process.cwd() + "/data",
  expireCode: 600000,
  expireLink: 8.64e7,
  maxFileSize: 1 * 1024 * 1024 * 1024,
} as const;

export default config;
