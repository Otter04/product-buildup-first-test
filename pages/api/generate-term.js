import { terms as initialTerms } from "@/lib/db";
const { GoogleGenerativeAI } = require("@google/generative-ai");

// In-memory cache for the demo (simulating Firestore)
let cache = { ...initialTerms };

// Initialize Gemini API
const getGenAI = (req) => {
  const key = req.headers['x-gemini-key'] || process.env.GEMINI_API_KEY;
  return key ? new GoogleGenerativeAI(key) : null;
};

export default async function handler(req, res) {
  const { id } = req.query;

  if (!id) {
    return res.status(400).json({ error: "Term ID is required" });
  }

  // 1. Check Cache
  if (cache[id]) {
    return res.status(200).json(cache[id]);
  }

  // 2. Use Gemini API
  const genAI = getGenAI(req);
  let aiGeneratedTerm = null;

  if (genAI) {
    try {
      const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
      
      const prompt = `
        You are an expert economic content editor for 'termlog'.
        For the economic term ID "${id}", generate a structured JSON response.
        
        Rules:
        1. "title": The name of the term in Korean (and English in parentheses).
        2. "summary": A trendy, hip one-line summary (use emojis).
        3. "description": A clear, engaging explanation in Korean.
        4. "color": A CSS variable (choose from: var(--neon-mint), var(--neon-blue), var(--neon-pink), var(--neon-yellow)).
        5. "deep_questions": An array of 3 objects with:
           - "question": A deep-dive question starting with "Q."
           - "link_term": A slug version of the linked term.
           - "link_term_kr": A short name for the link button in Korean.

        Return ONLY the raw JSON.
      `;

      console.log(`Generating content for term: ${id} using Gemini...`);
      const result = await model.generateContent(prompt);
      const response = await result.response;
      const text = response.text();
      console.log("Gemini response received:", text);
      
      // Extract JSON if AI includes markdown code blocks
      const jsonStr = text.match(/\{[\s\S]*\}/)?.[0] || text;
      aiGeneratedTerm = JSON.parse(jsonStr);
      aiGeneratedTerm.id = id;
    } catch (error) {
      console.error("Gemini API Error details:", error);
      aiGeneratedTerm = simulateAIResponse(id);
    }
  } else {
    // Fallback if no API key is provided
    aiGeneratedTerm = simulateAIResponse(id);
  }

  if (aiGeneratedTerm) {
    cache[id] = aiGeneratedTerm;
    return res.status(200).json(aiGeneratedTerm);
  }

  res.status(404).json({ error: "Failed to generate term knowledge" });
}

function simulateAIResponse(id) {
  const dynamicKnowledge = {
    "cost-push-inflation": {
      title: "비용 인상 인플레이션",
      summary: "물건을 만드는 데 드는 '비용'이 올라서 물가가 오르는 현상 📉",
      description: "원자재 가격(석유, 가스 등)이나 임금이 오르면 기업은 제품 가격을 올릴 수밖에 없습니다. 소비가 넘쳐서 생기는 '수요 견인' 인플레이션보다 훨씬 고통스러운 상황이죠.",
      color: "var(--neon-pink)",
      deep_questions: [
        { question: "Q. 원자재 가격은 왜 갑자기 오를까?", link_term: "supply-chain-crisis", link_term_kr: "공급망 위기" },
        { question: "Q. 임금이 오르면 왜 물가가 계속 오를까?", link_term: "wage-price-spiral", link_term_kr: "임금-물가 소용돌이" }
      ]
    },
    // ... rest of static definitions could be here
  };

  return dynamicKnowledge[id] || {
    title: id.replace(/-/g, ' ').toUpperCase(),
    summary: "AI가 실시간으로 분석 중인 새로운 경제 개념입니다 🤖",
    description: `${id}에 대한 상세한 경제적 맥락을 AI가 파악하고 있습니다. 이 개념은 현재 경제 생태계에서 중요한 연결 고리 역할을 합니다.`,
    color: "var(--neon-blue)",
    deep_questions: [
      { question: "Q. 이 개념이 시장에 미치는 영향은?", link_term: `${id}-impact`, link_term_kr: "시장 영향력" },
      { question: "Q. 관련된 핵심 지표는 무엇일까?", link_term: `${id}-metrics`, link_term_kr: "핵심 지표" }
    ]
  };
}
