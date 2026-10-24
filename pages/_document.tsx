import { Html, Head, Main, NextScript } from 'next/document';

export default function Document() {
  return (
    <Html lang="ko">
      <Head>
        <meta charSet="utf-8" />
        <meta
          name="description"
          content="설치 없이 QR·링크로 사진을 기기 간 직접(P2P) 주고받는 웹 서비스. 서버에 사진이 저장되지 않아요."
        />
        <meta name="theme-color" content="#2563eb" />
        {/* 모바일 웹앱(홈 화면 추가) */}
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-title" content="Photo Bridge" />
        <meta
          name="apple-mobile-web-app-status-bar-style"
          content="default"
        />
        {/* 이모지 파비콘 (별도 파일 없이 SVG inline) */}
        <link
          rel="icon"
          href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>📷</text></svg>"
        />
        {/* Open Graph (링크 공유 미리보기) */}
        <meta property="og:title" content="Photo Bridge" />
        <meta
          property="og:description"
          content="QR·링크로 사진을 직접 주고받기. 서버에 저장 안 됨."
        />
        <meta property="og:type" content="website" />
      </Head>
      <body>
        <Main />
        <NextScript />
      </body>
    </Html>
  );
}
