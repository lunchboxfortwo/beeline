import type { SqlDatabase } from './database.js';

// Keep uncertain input in English rather than guessing from a person's name or country.
const greetings = {
  en: (name: string) => `Hi ${name}, I'm Beebee and that's Luna. We're your free agents. We run on different AI models, so one of us does the work and the other checks it.\n\nWhat should we work on?`,
  es: (name: string) => `Hola ${name}, soy Beebee y esta es Luna. Somos tus agentes gratuitos. Usamos distintos modelos de IA: una hace el trabajo y la otra lo revisa.\n\n¿En qué trabajamos?`,
  fr: (name: string) => `Bonjour ${name}, je suis Beebee et voici Luna. Nous sommes tes agents gratuits. Nous utilisons différents modèles d’IA : l’une fait le travail et l’autre le vérifie.\n\nSur quoi veux-tu travailler ?`,
  de: (name: string) => `Hallo ${name}, ich bin Beebee und das ist Luna. Wir sind deine kostenlosen Agenten. Wir nutzen verschiedene KI-Modelle: Eine erledigt die Arbeit, die andere prüft sie.\n\nWoran sollen wir arbeiten?`,
  pt: (name: string) => `Olá ${name}, sou a Beebee e esta é a Luna. Somos suas agentes gratuitas. Usamos modelos de IA diferentes: uma faz o trabalho e a outra confere.\n\nEm que vamos trabalhar?`,
  it: (name: string) => `Ciao ${name}, sono Beebee e lei è Luna. Siamo le tue agenti gratuite. Usiamo modelli di IA diversi: una svolge il lavoro e l’altra lo controlla.\n\nA cosa lavoriamo?`,
  ko: (name: string) => `안녕하세요 ${name}, 저는 Beebee이고 이쪽은 Luna예요. 저희는 무료 에이전트예요. 서로 다른 AI 모델을 사용해서 한 명이 작업하면 다른 한 명이 검토해요.\n\n어떤 일을 함께 할까요?`,
  ja: (name: string) => `こんにちは ${name}、私はBeebee、こちらはLunaです。私たちは無料のエージェントです。異なるAIモデルを使い、一方が作業し、もう一方が確認します。\n\n何に取り組みましょうか？`,
  zh: (name: string) => `你好 ${name}，我是 Beebee，这位是 Luna。我们是你的免费智能体。我们使用不同的 AI 模型，一个负责工作，另一个负责检查。\n\n我们一起做什么？`,
  ru: (name: string) => `Привет ${name}, я Beebee, а это Luna. Мы твои бесплатные агенты. Мы используем разные модели ИИ: одна выполняет работу, другая проверяет.\n\nНад чем поработаем?`,
  ar: (name: string) => `مرحبًا ${name}، أنا Beebee وهذه Luna. نحن وكيلتان مجانيتان لك. نستخدم نموذجين مختلفين للذكاء الاصطناعي، فتقوم إحدانا بالعمل وتراجعه الأخرى.\n\nعلى ماذا نعمل؟`,
} satisfies Record<string, (name: string) => string>;
export type StarterLanguage = keyof typeof greetings;

export function starterLanguage(locale?: string | null, firstMessage = ''): StarterLanguage {
  const text = firstMessage.slice(0, 2000).trim().normalize('NFC');
  // A greeting mentioned inside a sentence is not evidence of its language;
  // an explicit request to speak a language is.
  // Unicode letter boundaries also preserve accented endings such as “Olá”.
  const signals: [StarterLanguage, RegExp][] = [
    ['ko', /[가-힣]{2}/u], ['ja', /[ぁ-ゖァ-ヺ]{2}/u],
    ['zh', /(?:你好|您好|中文|普通话|我們|我们)/u],
    ['ru', /(?:привет|здравствуйте|русском|русский)/iu],
    ['ar', /(?:مرحبا|مرحبًا|العربية|السلام عليكم)/u],
    ['es', /(?:^(?:hola|español|buenos días)|(?<![\p{L}\p{M}\p{N}_])(?:hablar|hablemos|habla|responde|escribe)\s+en\s+español)(?![\p{L}\p{M}\p{N}_])/iu],
    ['fr', /^(?:bonjour|français|salut)(?![\p{L}\p{M}\p{N}_])/iu],
    ['de', /^(?:hallo|deutsch|guten tag)(?![\p{L}\p{M}\p{N}_])/iu],
    ['pt', /^(?:olá|português|bom dia)(?![\p{L}\p{M}\p{N}_])/iu],
    ['it', /^(?:ciao|italiano|buongiorno)(?![\p{L}\p{M}\p{N}_])/iu],
    ['en', /\b(?:hello|english|good morning)\b/iu],
  ];
  const matches = signals.filter(([, pattern]) => pattern.test(text));
  if (matches.length === 1) return matches[0]![0];
  if (matches.length > 1) return 'en';
  try {
    const language = new Intl.Locale(locale ?? 'en').language;
    return Object.hasOwn(greetings, language) ? language as StarterLanguage : 'en';
  } catch { return 'en'; }
}

export function localizedStarterHello(name: string, language: StarterLanguage) {
  return greetings[language](name.trim().split(/\s+/u)[0] || (language === 'en' ? 'there' : '👋'));
}

export async function readStarterLanguage(database: SqlDatabase, roomId: string, userId: string | undefined) {
  const row = (await database.query<{ locale: string | null; first_message: string | null }>(
    `SELECT r.locale,(SELECT m.text FROM messages m WHERE m.room_id=$1 AND m.author_id=$2
      ORDER BY m.created_at,m.id LIMIT 1) first_message FROM starter_onboarding_runs r
     WHERE r.user_id=$2 ORDER BY (r.room_id=$1) DESC,r.created_at DESC LIMIT 1`, [roomId, userId])).rows[0];
  return starterLanguage(row?.locale, row?.first_message ?? '');
}
