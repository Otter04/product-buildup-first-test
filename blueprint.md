# Project Blueprint: termlog

## Overview
**termlog** (Term + Log) is an interactive, visual top-down economic knowledge platform. It features a high-energy "party-tech" aesthetic with heavy emphasis on glassmorphism and real-time knowledge extraction.

## Brand Identity & Aesthetic
- **Slogan:** "Explore the Lineage of Knowledge, termlog"
- **Visual Style:** 
  - **Background:** Deep obsidian/navy (#0a0a0c) with grain texture.
  - **Accents:** Neon Mint, Electric Blue, Hot Pink.
  - **Glassmorphism:** Enhanced backdrop-blur (30px+), high transparency (0.4 - 0.6), and subtle white borders (0.5px) for a "frosted glass" look.
  - **Interactivity:** Floating cards with soft, deep shadows and neon glows.

## Core Features
1. **Landing Page:** Professional yet vibrant entry point with a call-to-action ("학습하기").
2. **Infinite Log Timeline:** Exploration view where terms are appended as cards based on real-time data analysis.
3. **Real-time Data Extraction:** Dynamically generated term logs based on current economic trends and web data.

## Technical Architecture
- **Framework:** Next.js (Pages Router)
- **Animations:** Framer Motion (enhanced for glassmorphism transitions)
- **Data Engine:** `lib/db.js` (Transitioning to dynamic generation)

## Implementation Progress
- [x] Foundation & Cleanup
- [x] Global Theme & Neon Styles
- [x] Initial Knowledge Base
- [ ] **Landing Page (New Main Page)**
- [ ] **Enhanced Glassmorphism UI (LogEntry & Global Styles)**
- [ ] **Extended Knowledge Log (Macro-economics & Trends)**
