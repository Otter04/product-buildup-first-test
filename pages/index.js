import Head from "next/head";
import Link from "next/link";
import { motion } from "framer-motion";
import { Geist, Geist_Mono } from "next/font/google";
import styles from "@/styles/Landing.module.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export default function Landing() {
  return (
    <div className={`${styles.container} ${geistSans.variable} ${geistMono.variable}`}>
      <Head>
        <title>termlog - 지식의 계보를 기록하다</title>
        <meta name="description" content="비주얼 탑다운 경제 지식 플랫폼, termlog" />
      </Head>

      <div className={styles.background}>
        <div className={styles.blob1}></div>
        <div className={styles.blob2}></div>
        <div className={styles.blob3}></div>
      </div>

      <nav className={styles.nav}>
        <div className={styles.logo}>
          <span className={styles.logoText}>termlog</span>
          <span className={styles.cursor}>_</span>
        </div>
      </nav>

      <main className={styles.main}>
        <motion.div 
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.8 }}
          className={styles.hero}
        >
          <h1 className={styles.title}>
            지식의 계보를 <br />
            <span className={styles.highlight}>기록하고 탐험하다</span>
          </h1>
          <p className={styles.subtitle}>
            경제 용어의 미로 속에서 길을 잃지 마세요. <br />
            termlog는 복잡한 개념을 탑다운 방식으로 연결하여 <br />
            당신만의 지식 로그를 완성해 드립니다.
          </p>

          <div className={styles.ctaGroup}>
            <Link href="/explore" className={styles.primaryBtn}>
              학습 시작하기
              <span className={styles.btnGlow}></span>
            </Link>
            <button className={styles.secondaryBtn}>
              서비스 소개
            </button>
          </div>
        </motion.div>

        <motion.div 
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ delay: 0.5, duration: 1 }}
          className={styles.preview}
        >
          <div className={`${styles.previewCard} glass`}>
            <div className={styles.previewHeader}>
              <div className={styles.dot}></div>
              <div className={styles.dot}></div>
              <div className={styles.dot}></div>
            </div>
            <div className={styles.previewContent}>
              <div className={styles.previewLine}></div>
              <div className={styles.previewLine} style={{ width: "60%" }}></div>
              <div className={styles.previewLine} style={{ width: "80%" }}></div>
            </div>
          </div>
        </motion.div>
      </main>

      <footer className={styles.footer}>
        <p>© 2026 termlog. All rights reserved.</p>
      </footer>
    </div>
  );
}
