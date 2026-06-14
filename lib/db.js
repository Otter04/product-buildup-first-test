export const terms = {
  "inflation": {
    id: "inflation",
    title: "인플레이션 (Inflation)",
    summary: "물가 수준이 지속적으로 상승하여 화폐 가치가 하락하는 현상.",
    description: "인플레이션은 경제의 '온도'와 같습니다. 적절한 인플레이션은 경제 성장의 신호가 될 수 있지만, 너무 가파른 상승은 구매력 하락과 자산 가치 변동을 초래합니다.",
    color: "var(--neon-pink)",
    deep_questions: [
      { question: "물가를 잡기 위해 금리는 왜 올려야 할까?", link_term: "interest-rate", link_term_kr: "금리와의 관계" },
      { question: "물가가 오르는데 경기가 안 좋을 수도 있을까?", link_term: "stagflation", link_term_kr: "스태그플레이션" },
      { question: "중앙은행은 어떻게 물가를 조절할까?", link_term: "central-bank", link_term_kr: "중앙은행의 역할" }
    ]
  },
  "interest-rate": {
    id: "interest-rate",
    title: "금리 (Interest Rate)",
    summary: "돈의 가격, 즉 자본의 기회비용입니다.",
    description: "중앙은행이 결정하는 기준금리는 시장의 모든 자금 흐름에 영향을 미칩니다. 고금리는 긴축을, 저금리는 완화를 의미하며 이는 주식, 부동산, 가상자산 등 모든 자산 시장의 향방을 결정합니다.",
    color: "var(--neon-mint)",
    deep_questions: [
      { question: "금리가 오르면 왜 주식 시장은 하락할까?", link_term: "stock-market-impact", link_term_kr: "주식 시장 영향" },
      { question: "금리 조절로도 해결이 안 되면 어떻게 할까?", link_term: "quantitative-easing", link_term_kr: "양적완화" },
      { question: "미국 금리가 한국에 미치는 영향은?", link_term: "exchange-rate", link_term_kr: "환율과 외환" }
    ]
  },
  "stagflation": {
    id: "stagflation",
    title: "스태그플레이션 (Stagflation)",
    summary: "경기 침체(Stagnation)와 물가 상승(Inflation)이 동시에 발생하는 최악의 시나리오.",
    description: "전통적인 경제 이론으로는 설명하기 힘든 현상으로, 공급 측면의 충격(에너지 가격 폭등 등)에 의해 발생하며 정책적 대응이 매우 까다롭습니다.",
    color: "var(--neon-yellow)",
    deep_questions: [
      { question: "경기가 안 좋은데 왜 물가가 오르는 걸까?", link_term: "cost-push-inflation", link_term_kr: "비용 인상 인플레이션" },
      { question: "정부나 중앙은행은 왜 손을 쓰기 힘들까?", link_term: "monetary-policy-dilemma", link_term_kr: "통화정책의 딜레마" },
      { question: "역사적으로 실제로 이런 일이 있었을까?", link_term: "1970s-oil-shock", link_term_kr: "1970년대 오일쇼크" }
    ]
  }
};

export const getTerm = (id) => terms[id] || null;
