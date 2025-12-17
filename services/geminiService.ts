import { GoogleGenAI } from "@google/genai";
import { AppSearchResult, AppAnalysis, ChatMessage } from '../types';

// Declare process for Vite environment variable usage in TS
declare const process: { env: { API_KEY: string } };

// API Key must be obtained from environment variables
const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

// Model Constants
const MODEL_NAME = "gemini-2.5-flash";

// Token Management
const MAX_CONTEXT_CHARS = 60000;

const manageContextWindow = (history: ChatMessage[], systemContext: string): ChatMessage[] => {
  let currentChars = systemContext.length;
  const safeHistory: ChatMessage[] = [];
  for (let i = history.length - 1; i >= 0; i--) {
    const msg = history[i];
    const msgLen = msg.content.length;
    if (currentChars + msgLen < MAX_CONTEXT_CHARS) {
      safeHistory.unshift(msg);
      currentChars += msgLen;
    } else {
      break;
    }
  }
  return safeHistory;
};

const extractJson = <T>(text: string): T | null => {
  try {
    let cleanText = text.trim();
    const match = cleanText.match(/```json\s*([\s\S]*?)\s*```/) || cleanText.match(/```\s*([\s\S]*?)\s*```/);
    if (match && match[1]) cleanText = match[1];
    return JSON.parse(cleanText);
  } catch (error) {
    console.warn("JSON extraction failed, attempting fallback parsing.", error);
    try {
      const firstOpen = text.indexOf('{');
      const lastClose = text.lastIndexOf('}');
      if (firstOpen !== -1 && lastClose !== -1) {
         return JSON.parse(text.substring(firstOpen, lastClose + 1));
      }
      // Try array fallback
      const firstArray = text.indexOf('[');
      const lastArray = text.lastIndexOf(']');
      if (firstArray !== -1 && lastArray !== -1) {
         return JSON.parse(text.substring(firstArray, lastArray + 1));
      }
    } catch(e) {}
  }
  return null;
};

// Helper to clean "glitched" AI outputs into clean strings
// NOW ACCEPTS A FALLBACK RATING from the search step
const cleanData = (analysis: AppAnalysis, fallbackRating?: string): AppAnalysis => {
  const cleanRating = (r: string) => {
    // 1. Try to extract a valid float rating from the analysis (e.g. "4.5")
    const match = r ? r.match(/([0-5]\.\d)/) : null;
    if (match) return match[0];
    
    // 2. Fallback to the rating found during the initial search
    // CRITICAL FIX: Ensure fallback is strictly a 0-5 number. 
    // Prevents "100" (from downloads) being used as rating if regex was too loose.
    if (fallbackRating && 
        fallbackRating !== "N/A" && 
        /^[0-5](\.\d)?$/.test(fallbackRating)) {
      return fallbackRating;
    }

    // 3. Fallback for integer ratings like "4"
    if (r && /^[1-5]$/.test(r)) return r + ".0";

    return "N/A";
  };

  const cleanDownloads = (d: string) => {
    if (!d || d === "N/A") return "N/A";
    
    // Normalize: Remove "Downloads", "Over", "Approx", "Installations"
    let val = d.replace(/downloads|over|approx|more than|installations/gi, '').trim();

    // Helper to standardise words to suffixes
    if (val.match(/million/i)) val = val.replace(/million/i, 'M');
    if (val.match(/billion/i)) val = val.replace(/billion/i, 'B');
    if (val.match(/thousand/i)) val = val.replace(/thousand/i, 'k');

    // Regex to capture:
    // 1. Comma separated numbers with optional plus (e.g. 1,000,000 or 1,000+)
    // 2. Numbers with Suffixes (100M, 1.5B, 500k) with optional +
    // 3. Simple Number + Plus sign (500+, 10+)
    // 4. Plain numbers with at least 3 digits (e.g. 5000)
    // Note: We deliberately avoid matching small plain numbers like "50" to avoid confusion.
    const match = val.match(/(\d{1,3}(,\d{3})+(\+)?)|(\d+(\.\d+)?\s*[MBK]\+?)|(\d+\+)|(\d{3,}\+?)/i);
    
    if (match) {
      // Normalize: remove spaces, uppercase (e.g. "100 m+" -> "100M+")
      return match[0].toUpperCase().replace(/\s/g, '');
    }
    
    return "N/A";
  };

  const cleanDate = (d: string) => {
    if (!d) return undefined; 
    
    // Match specific date formats only. 
    // If it's "Recently" or "Unknown", this regex won't match, so we return undefined.
    // Updated regex to allow full month names (2 or more letters)
    const match = d.match(/([A-Z][a-z]{2,}\s\d{1,2},\s\d{4})|(\d{4}-\d{2}-\d{2})|(\d{1,2}\s[A-Z][a-z]{2,}\s\d{4})/i);
    if (match) return match[0];
    
    return undefined;
  };

  return {
    ...analysis,
    reviewSummary: analysis.reviewSummary || "No review summary could be generated.",
    authenticity: analysis.authenticity || "Authenticity check could not be completed.",
    background: analysis.background || "Developer background information unavailable.",
    rating: cleanRating(analysis.rating),
    downloads: cleanDownloads(analysis.downloads),
    lastUpdated: cleanDate(analysis.lastUpdated || "")
  };
};

export const searchApps = async (query: string): Promise<AppSearchResult[]> => {
  try {
    const searchPrompt = `site:play.google.com/store/apps/details ${query}`;
    
    const response = await ai.models.generateContent({
      model: MODEL_NAME,
      contents: `
        Perform a Google Search for: "${searchPrompt}".
        
        Task: Find REAL Android apps listed on the Google Play Store (play.google.com).
        Strictly extract details from the search snippets.
        
        Return a JSON array of the top 3 results.
        
        Format:
        [
          {
            "name": "Exact App Name",
            "developer": "Developer Name",
            "description": "Short description.",
            "rating": "4.5" 
          }
        ]
      `,
      config: {
        tools: [{ googleSearch: {} }] 
      }
    });

    const data = extractJson<AppSearchResult[]>(response.text || "[]");
    
    return (data || []).map(app => ({
      ...app,
      // Stricter cleanup for search results to prevent "100" or other numbers from being mistaken as rating
      rating: app.rating ? (app.rating.match(/([0-5](\.\d)?)/)?.[0] || "N/A") : "N/A"
    }));
  } catch (error) {
    console.error("Error searching apps:", error);
    throw error;
  }
};

export const analyzeApp = async (app: AppSearchResult): Promise<AppAnalysis> => {
  try {
    // Expanded context search to get better hit rate on details
    const response = await ai.models.generateContent({
      model: MODEL_NAME,
      contents: `
        Analyze the Android app "${app.name}" by "${app.developer}".
        
        Use Google Search to find the official Google Play Store page.
        
        Extract the following statistics:
        1. Rating: The star rating (e.g., 4.5).
        2. Downloads: The number of downloads (e.g., "100M+", "1B+", "50k+").
        3. Last Updated: The date of the last update.
        4. Review Summary: Summarize user sentiment.
        5. Authenticity: Is this the official app?
        6. Background: Developer info.

        Return strictly valid JSON:
        {
          "reviewSummary": "...",
          "authenticity": "...",
          "background": "...",
          "rating": "4.5",
          "downloads": "100M+",
          "lastUpdated": "Oct 24, 2024"
        }
      `,
      config: {
        tools: [{ googleSearch: {} }]
      }
    });

    const rawAnalysis = extractJson<AppAnalysis>(response.text || "{}");
    
    if (!rawAnalysis) throw new Error("Could not parse analysis");

    const groundingUrls: string[] = [];
    const chunks = response.candidates?.[0]?.groundingMetadata?.groundingChunks;
    if (chunks) {
      chunks.forEach((chunk: any) => {
        if (chunk.web?.uri) groundingUrls.push(chunk.web.uri);
      });
    }

    // Pass the search-result rating as a fallback in case the deep analysis fails to find it
    const cleanAnalysis = cleanData(rawAnalysis, app.rating);

    return {
      ...cleanAnalysis,
      groundingUrls: Array.from(new Set(groundingUrls))
    };
    
  } catch (error) {
    console.error("Error analyzing app:", error);
    throw error;
  }
};

export const chatWithApp = async (
  history: ChatMessage[], 
  newMessage: string, 
  appContext: AppSearchResult, 
  analysisContext: AppAnalysis
): Promise<string> => {
  
  const systemInstruction = `
    You are an expert app safety assistant.
    App: "${appContext.name}" by "${appContext.developer}".
    
    Stats:
    - Rating: ${analysisContext.rating}
    - Downloads: ${analysisContext.downloads}
    
    Analysis Context:
    - Reviews: ${analysisContext.reviewSummary}
    - Safety: ${analysisContext.authenticity}
    - Dev: ${analysisContext.background}
    
    Answer concisely. Do not use LaTeX or markdown math syntax (like $ or \\frac). Use plain text or simple arithmetic notation for formulas.
  `;

  const cleanHistory = manageContextWindow(history, systemInstruction + newMessage);

  const contents = [
    ...cleanHistory.map(msg => ({
      role: msg.role,
      parts: [{ text: msg.content }]
    })),
    {
      role: 'user',
      parts: [{ text: newMessage }]
    }
  ];

  try {
    const response = await ai.models.generateContent({
      model: MODEL_NAME,
      contents: contents,
      config: {
        systemInstruction: systemInstruction,
      }
    });

    return response.text || "No response generated.";
  } catch (error) {
    console.error("Chat error:", error);
    throw error;
  }
};