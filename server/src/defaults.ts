export interface DefaultCategory {
  name: string;
  kind: 'expense' | 'income' | 'transfer';
  group: string;
  essential?: boolean;
}

export const DEFAULT_CATEGORIES: DefaultCategory[] = [
  { name: 'Salary', kind: 'income', group: 'Income' },
  { name: 'Other income', kind: 'income', group: 'Income' },
  { name: 'Interest & dividends', kind: 'income', group: 'Income' },

  { name: 'Housing & rent', kind: 'expense', group: 'Home', essential: true },
  { name: 'Utilities', kind: 'expense', group: 'Home', essential: true },
  { name: 'Phone & internet', kind: 'expense', group: 'Home', essential: true },
  { name: 'Home & garden', kind: 'expense', group: 'Home' },

  { name: 'Groceries', kind: 'expense', group: 'Food', essential: true },
  { name: 'Dining & delivery', kind: 'expense', group: 'Food' },

  { name: 'Public transport & taxi', kind: 'expense', group: 'Transport', essential: true },
  { name: 'Fuel & car', kind: 'expense', group: 'Transport', essential: true },

  { name: 'Insurance', kind: 'expense', group: 'Financial', essential: true },
  { name: 'Loan repayment', kind: 'expense', group: 'Financial', essential: true },
  { name: 'Bank fees & interest', kind: 'expense', group: 'Financial' },
  { name: 'Taxes & government', kind: 'expense', group: 'Financial', essential: true },

  { name: 'Health & pharmacy', kind: 'expense', group: 'Wellbeing', essential: true },
  { name: 'Personal care', kind: 'expense', group: 'Wellbeing' },
  { name: 'Fitness & sports', kind: 'expense', group: 'Wellbeing' },

  { name: 'Subscriptions', kind: 'expense', group: 'Lifestyle' },
  { name: 'Entertainment', kind: 'expense', group: 'Lifestyle' },
  { name: 'Shopping', kind: 'expense', group: 'Lifestyle' },
  { name: 'Electronics', kind: 'expense', group: 'Lifestyle' },
  { name: 'Travel', kind: 'expense', group: 'Lifestyle' },
  { name: 'Education', kind: 'expense', group: 'Lifestyle' },
  { name: 'Kids & family', kind: 'expense', group: 'Lifestyle' },
  { name: 'Gifts & donations', kind: 'expense', group: 'Lifestyle' },

  { name: 'Cash withdrawal', kind: 'expense', group: 'Other' },
  { name: 'Other expenses', kind: 'expense', group: 'Other' },

  { name: 'Transfers', kind: 'transfer', group: 'Transfers' },
  { name: 'Savings & investments', kind: 'transfer', group: 'Transfers' },
];

export interface DefaultRule {
  category: string;
  patterns: string[];
  field?: 'any' | 'counterparty' | 'description' | 'mcc';
  direction?: 'any' | 'in' | 'out';
  regex?: boolean;
  priority?: number;
}

/**
 * Starter rules, tuned for Hungarian merchants. Patterns are matched against
 * diacritic-stripped, lower-cased text. Lower priority number wins.
 */
export const DEFAULT_RULES: DefaultRule[] = [
  { category: 'Dining & delivery', priority: 400, patterns: ['bolt food', 'wolt', 'foodora', 'netpincer'] },
  { category: 'Groceries', patterns: ['lidl', 'aldi', 'spar', 'tesco', 'auchan', 'penny', 'cba ', 'coop ', 'príma', 'prima ', 'kifli.hu', 'roksh'] },
  { category: 'Dining & delivery', patterns: ['mcdonald', 'burger king', 'kfc', 'starbucks', 'costa coffee', 'etterem', 'restaurant', 'bistro', 'pizz', 'kavezo', 'cafe', 'bufe'] },
  { category: 'Public transport & taxi', patterns: ['bkk', 'budapestgo', 'mav-start', 'mav start', 'volan', 'bolt.eu', 'bolt operations', 'uber', 'fotaxi', 'mol bubi', 'lime*', 'tier '] },
  { category: 'Fuel & car', patterns: ['mol ', 'shell', 'omv', 'orlen', 'autopalya', 'nemzeti utdij', 'parkol', 'autoszerviz', 'gumiszerviz'] },
  { category: 'Subscriptions', patterns: ['netflix', 'spotify', 'hbo', 'disney', 'youtube', 'apple.com/bill', 'google one', 'google storage', 'icloud', 'amazon prime', 'skyshowtime', 'adobe', 'microsoft', 'dropbox', 'openai', 'chatgpt', 'anthropic', 'claude.ai', 'github', 'notion', 'patreon', 'audible', 'revolut premium', 'revolut metal', 'plan fee'] },
  { category: 'Phone & internet', patterns: ['telekom', 'yettel', 'vodafone', 'one magyarorszag', 'digi ', 'digi tavkozlesi', 'invitech'] },
  { category: 'Utilities', patterns: ['mvm', 'e.on', 'eon ', 'fovarosi vizmuvek', 'vizmu', 'fotav', 'mohu', 'fkf', 'kozos koltseg', 'tarsashaz', 'dijbeszedo'] },
  { category: 'Insurance', patterns: ['biztosito', 'allianz', 'generali', 'groupama', 'uniqa', 'aegon', 'alfa vienna', 'union vienna', 'signal iduna', 'kobe', 'genertel', 'insurance'] },
  { category: 'Health & pharmacy', patterns: ['gyogyszertar', 'patika', 'benu', 'pharma', 'fogaszat', 'dental', 'medicover', 'doktor24', 'swiss clinic', 'optika', 'egeszsegpenztar'] },
  { category: 'Personal care', patterns: ['rossmann', 'dm-drogerie', 'dm drogerie', 'dm kft', 'muller', 'douglas', 'fodrasz', 'barber', 'kozmetik'] },
  { category: 'Fitness & sports', patterns: ['decathlon', 'fitness', 'gym', 'all you can move', 'aycm', 'uszoda', 'hervis', 'intersport'] },
  { category: 'Electronics', patterns: ['media markt', 'mediamarkt', 'alza', 'emag', 'euronics', 'istyle', 'ipon', 'aqua.hu'] },
  { category: 'Home & garden', patterns: ['ikea', 'obi ', 'praktiker', 'bauhaus', 'jysk', 'kika', 'xxxlutz', 'mobelix'] },
  { category: 'Shopping', patterns: ['h&m', 'zara', 'c&a', 'reserved', 'pepco', 'about you', 'aboutyou', 'zalando', 'amazon', 'aliexpress', 'temu', 'shein', 'ebay', 'vinted', 'libri', 'bookline', 'lego'] },
  { category: 'Entertainment', patterns: ['cinema city', 'mozi', 'jegy.hu', 'ticketportal', 'funcode', 'steam', 'playstation', 'nintendo', 'xbox', 'szinhaz', 'muzeum'] },
  { category: 'Travel', patterns: ['booking.com', 'airbnb', 'wizz', 'ryanair', 'lufthansa', 'szallas.hu', 'hotel', 'flixbus', 'regiojet', 'trip.com'] },
  { category: 'Education', patterns: ['udemy', 'coursera', 'duolingo', 'tandij', 'nyelviskola'] },
  { category: 'Taxes & government', patterns: ['nav ', 'nemzeti ado', 'magyar allamkincstar', 'onkormanyzat', 'illetek'] },
  { category: 'Cash withdrawal', direction: 'out', patterns: ['atm', 'keszpenzfelvet', 'cash withdrawal'] },
  { category: 'Bank fees & interest', direction: 'out', patterns: ['szamlavezetesi dij', 'tranzakcios illetek', 'kartyadij', 'eves dij', 'havi dij', 'jutalek', 'account fee', 'sms dij', 'csomagdij', 'kamat terheles'] },
  { category: 'Loan repayment', direction: 'out', patterns: ['torleszt', 'hitel', 'lizing', 'loan repayment'] },
  { category: 'Housing & rent', direction: 'out', patterns: ['berleti dij', 'lakber', 'alberlet', 'rent '] },
  { category: 'Salary', direction: 'in', priority: 300, patterns: ['munkaber', 'fizetes', 'salary', 'payroll', 'ber '] },
  { category: 'Interest & dividends', direction: 'in', priority: 300, patterns: ['kamat', 'interest', 'osztalek', 'dividend'] },
  { category: 'Savings & investments', patterns: ['allampapir', 'interactive brokers', 'random capital', 'erste befektetesi', 'lightyear', 'trading 212', 'savings vault', 'nyugdijpenztar'] },

  // Merchant category code fallbacks (card payments), tried after the name rules.
  { category: 'Groceries', field: 'mcc', priority: 900, patterns: ['5411', '5422', '5441', '5451', '5462', '5499'] },
  { category: 'Dining & delivery', field: 'mcc', priority: 900, patterns: ['5811', '5812', '5813', '5814'] },
  { category: 'Fuel & car', field: 'mcc', priority: 900, patterns: ['5541', '5542', '7523', '7538', '7542', '4784'] },
  { category: 'Public transport & taxi', field: 'mcc', priority: 900, patterns: ['4111', '4112', '4121', '4131'] },
  { category: 'Health & pharmacy', field: 'mcc', priority: 900, patterns: ['5912', '8011', '8021', '8062', '8099', '8043'] },
  { category: 'Phone & internet', field: 'mcc', priority: 900, patterns: ['4812', '4814', '4899'] },
  { category: 'Utilities', field: 'mcc', priority: 900, patterns: ['4900'] },
  { category: 'Insurance', field: 'mcc', priority: 900, patterns: ['6300', '5960'] },
  { category: 'Travel', field: 'mcc', priority: 900, patterns: ['4511', '4722', '7011', '3000'] },
  { category: 'Entertainment', field: 'mcc', priority: 900, patterns: ['7832', '7922', '7991', '7996', '5816'] },
  { category: 'Shopping', field: 'mcc', priority: 900, patterns: ['5311', '5611', '5621', '5651', '5661', '5691', '5942', '5945'] },
  { category: 'Electronics', field: 'mcc', priority: 900, patterns: ['5732', '5734', '5045'] },
  { category: 'Cash withdrawal', field: 'mcc', priority: 900, patterns: ['6011', '6010'] },
];
