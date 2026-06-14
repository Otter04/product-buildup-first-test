import { motion } from "framer-motion";
import styles from "./LogEntry.module.css";
import { getTerm } from "@/lib/db";

export default function LogEntry({ termId, data, onSelect, isActive }) {
  if (!data) return null;

  return (
    <motion.div
      initial={{ opacity: 0, x: 50, scale: 0.95 }}
      animate={{ opacity: 1, x: 0, scale: 1 }}
      className={`${styles.card} ${isActive ? styles.active : ""}`}
      style={{ "--accent-color": data.color }}
    >
      <div className={styles.header}>
        <span className={styles.tag}>TERM LOG</span>
        <h2 className={styles.title}>{data.title}</h2>
      </div>
      
      <p className={styles.summary}>{data.summary}</p>
      
      <div className={styles.content}>
        <p>{data.description}</p>
      </div>

      <div className={styles.footer}>
        <h3 className={styles.subTitle}>깊이 파고들기 (Deep Dive)</h3>
        <div className={styles.questions}>
          {data.deep_questions?.map((q, i) => (
            <button
              key={i}
              onClick={() => onSelect(q.link_term)}
              className={styles.questionBtn}
            >
              <span className={styles.qText}>{q.question}</span>
              <span className={styles.linkText}>{q.link_term_kr} →</span>
            </button>
          ))}
        </div>
      </div>
    </motion.div>
  );
}
