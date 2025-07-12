/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'export', // 이 설정을 추가하여 정적 빌드
  distDir: 'out', // 빌드 결과물이 'out' 디렉토리에 생성되도록 (Nginx와 일치)
};

module.exports = nextConfig;