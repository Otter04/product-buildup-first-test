import Head from "next/head";
import Link from "next/link";
import { useState, useRef, useEffect } from "react";
import { motion } from "framer-motion";
import { Geist, Geist_Mono } from "next/font/google";
import styles from "@/styles/Explore.module.css";
import LogEntry from "@/components/LogEntry";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export default function Explore() {
  const [history, setHistory] = useState([]);
  const [termData, setTermData] = useState({});
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  const scrollRef = useRef(null);

  // Load API key from local storage on mount
  useEffect(() => {
    const savedKey = localStorage.getItem("gemini_api_key");
    if (savedKey) setApiKey(savedKey);
  }, []);

  const fetchTerm = async (termId) => {
    if (termData[termId]) return;
    setLoading(true);
    setErrorMsg("");
    try {
      const res = await fetch(`/api/generate-term?id=${termId}`, {
        headers: {
          'x-gemini-key': apiKey
        }
      });
      
      const data = await res.json();
      
      if (!res.ok) {
        throw new Error(data.error || "Failed to fetch");
      }
      
      setTermData(prev => ({ ...prev, [termId]: data }));
    } catch (error) {
      console.error("Failed to fetch term:", error);
      setErrorMsg(error.message);
    } finally {
      setLoading(false);
    }
  };

  const handleApiKeyChange = (e) => {
    const newKey = e.target.value;
    setApiKey(newKey);
    localStorage.setItem("gemini_api_key", newKey);
  };

  const handleSelect = async (termId) => {
    if (!history.includes(termId)) {
      await fetchTerm(termId);
      setHistory(prev => [...prev, termId]);
    }
  };

  // Initial fetch
  useEffect(() => {
    handleSelect("inflation");
  }, []);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTo({
        left: scrollRef.current.scrollWidth,
        behavior: "smooth",
      });
    }
  }, [history]);

  return (
    <div className={`${styles.container} ${geistSans.variable} ${geistMono.variable}`}>
      <Head>
        <title>Explore - termlog</title>
      </Head>

      <header className={styles.header}>
        <Link href="/" className={styles.logo}>
          <span className={styles.logoText}>termlog</span>
          <span className={styles.cursor}>_</span>
        </Link>
        <nav className={styles.nav}>
          <button 
            className={styles.settingsBtn} 
            onClick={() => setShowSettings(!showSettings)}
            title="Gemini API 설정"
          >
            {apiKey ? "✅ API 연결됨" : "🔑 API 설정"}
          </button>
          <button className={styles.resetBtn} onClick={() => {
            setHistory(["inflation"]);
            fetchTerm("inflation");
          }}>
            탐험 초기화
          </button>
        </nav>
        
        {showSettings && (
          <motion.div 
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            className={styles.settingsPanel}
          >
            <div className={styles.settingsHeader}>
              <label>Gemini API Key</label>
              <button onClick={() => setShowSettings(false)} className={styles.closeBtn}>✕</button>
            </div>
            <input 
              type="password" 
              value={apiKey} 
              onChange={handleApiKeyChange}
              placeholder="AI 기능을 위해 API 키를 입력하세요"
            />
            <p>키를 입력하면 AI가 실시간으로 지식을 생성합니다.</p>
          </motion.div>
        )}
      </header>

      <main className={styles.main}>
        <div className={styles.timelineWrapper} ref={scrollRef}>
          <div className={styles.timeline}>
            {history.map((termId, index) => (
              <LogEntry
                key={`${termId}-${index}`}
                termId={termId}
                data={termData[termId]}
                onSelect={handleSelect}
                isActive={index === history.length - 1}
              />
            ))}
            {loading && (
              <div className={styles.loadingCard}>
                <div className={styles.spinner}></div>
                <p>AI가 로그를 분석 중입니다...</p>
              </div>
            )}
            {errorMsg && (
              <div className={styles.errorCard}>
                <p>⚠️ {errorMsg}</p>
                <button onClick={() => fetchTerm(history[history.length - 1])} className={styles.retryBtn}>
                  다시 시도
                </button>
              </div>
            )}
            {history.length === 1 && !loading && (
              <div className={styles.intro}>
                <p>AI가 제안하는 질문을 클릭하여 깊이 파고들어 보세요.</p>
                <div className={styles.arrow}>→</div>
              </div>
            )}
          </div>
        </div>
      </main>

      <footer className={styles.footer}>
        <div className={styles.status}>
          <span className={styles.dot}></span>
          LIVE EXPLORATION: {history.length} LOGS ACTIVE
        </div>
      </footer>
    </div>
  );
}
