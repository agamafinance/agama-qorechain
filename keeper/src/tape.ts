/**
 * The loan tape: the document private credit runs on and a public chain cannot publish. Who borrowed, against
 * what collateral, at what rate, and whether they are paying.
 *
 * The book is simulated (Agama's ABF partner runs no testnet), so the tape is generated: a fixed portfolio of
 * fictional SME facilities across three asset-backed sleeves, scaled to the book's marked value and aged by the
 * calendar. It is deterministic for a given book and day, so every reader who decrypts it, and the issuer's hash
 * on Ethereum, agree on the same bytes.
 */

export type Loan = {
  id: string;
  borrower: string;
  country: string;
  sleeve: string;
  collateral: string;
  outstanding: string; // USDC base units
  rateBps: number;
  maturity: string;
  ltvBps: number;
  status: "current" | "watch" | "30dpd";
};

export type LoanTape = {
  asOf: string;
  aprBps: number;
  book: string;
  sleeves: { name: string; outstanding: string; loans: number; weightedRateBps: number }[];
  loans: Loan[];
  concentration: { largestBorrowerBps: number; topFiveBps: number };
  delinquency: { watchBps: number; dpd30Bps: number };
};

const PORTFOLIO: Omit<Loan, "outstanding" | "status" | "maturity">[] = [
  { id: "TR-0141", borrower: "Halden Logistik GmbH", country: "DE", sleeve: "Trade receivables", collateral: "Invoices, 412 debtors", rateBps: 980, ltvBps: 8_000 },
  { id: "TR-0153", borrower: "Ostrava Precision s.r.o.", country: "CZ", sleeve: "Trade receivables", collateral: "Invoices, 96 debtors", rateBps: 1_040, ltvBps: 8_000 },
  { id: "TR-0167", borrower: "Lumen Foods BV", country: "NL", sleeve: "Trade receivables", collateral: "Invoices, 1,280 debtors", rateBps: 910, ltvBps: 8_500 },
  { id: "TR-0172", borrower: "Ribera Textil SL", country: "ES", sleeve: "Trade receivables", collateral: "Invoices, 233 debtors", rateBps: 1_090, ltvBps: 7_500 },
  { id: "TR-0188", borrower: "Nordvik Marine AS", country: "NO", sleeve: "Trade receivables", collateral: "Invoices, 58 debtors", rateBps: 1_010, ltvBps: 7_500 },
  { id: "EL-0209", borrower: "Brabant Agri Leasing NV", country: "BE", sleeve: "Equipment leases", collateral: "112 tractors and harvesters", rateBps: 870, ltvBps: 7_000 },
  { id: "EL-0214", borrower: "Calder Medical Ltd", country: "IE", sleeve: "Equipment leases", collateral: "38 imaging units", rateBps: 820, ltvBps: 6_500 },
  { id: "EL-0226", borrower: "Vaud Machines SA", country: "CH", sleeve: "Equipment leases", collateral: "CNC fleet, 64 units", rateBps: 845, ltvBps: 7_000 },
  { id: "EL-0231", borrower: "Lyon Froid SAS", country: "FR", sleeve: "Equipment leases", collateral: "Refrigerated trailers, 140", rateBps: 905, ltvBps: 7_500 },
  { id: "CI-0302", borrower: "Kredo Instalments GmbH", country: "AT", sleeve: "Consumer instalments", collateral: "9,400 BNPL contracts", rateBps: 1_150, ltvBps: 8_500 },
  { id: "CI-0317", borrower: "Mirella Pay Srl", country: "IT", sleeve: "Consumer instalments", collateral: "14,200 instalment plans", rateBps: 1_210, ltvBps: 8_500 },
  { id: "CI-0325", borrower: "Saari Finance Oy", country: "FI", sleeve: "Consumer instalments", collateral: "5,700 auto loans", rateBps: 1_060, ltvBps: 8_000 },
];

/** Book weight of each facility, in thousandths: sleeves at 50 / 30 / 20 percent. */
const WEIGHTS = [130, 90, 120, 85, 75, 90, 60, 80, 70, 85, 60, 55];

// mulberry32: a tiny seeded PRNG, so a tape is the same for everyone who regenerates it.
function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function loanTape(book: bigint, at: number, aprBps = 900): LoanTape {
  const day = Math.floor(at / 86_400);
  const rand = rng(day * 2_654_435_761);
  const total = WEIGHTS.reduce((a, b) => a + b, 0);
  let assigned = 0n;
  const loans: Loan[] = PORTFOLIO.map((p, i) => {
    const outstanding = i === PORTFOLIO.length - 1 ? book - assigned : (book * BigInt(WEIGHTS[i])) / BigInt(total);
    assigned += outstanding;
    const r = rand();
    const status: Loan["status"] = r < 0.04 ? "30dpd" : r < 0.13 ? "watch" : "current";
    const months = 6 + Math.floor(rand() * 30);
    const maturity = new Date((day + months * 30) * 86_400_000).toISOString().slice(0, 10);
    return { ...p, outstanding: outstanding.toString(), status, maturity };
  });

  const sleeves = [...new Set(PORTFOLIO.map((p) => p.sleeve))].map((name) => {
    const ls = loans.filter((l) => l.sleeve === name);
    const out = ls.reduce((a, l) => a + BigInt(l.outstanding), 0n);
    const wr = out === 0n ? 0 : Number(ls.reduce((a, l) => a + BigInt(l.outstanding) * BigInt(l.rateBps), 0n) / out);
    return { name, outstanding: out.toString(), loans: ls.length, weightedRateBps: wr };
  });

  const bps = (x: bigint) => (book === 0n ? 0 : Number((x * 10_000n) / book));
  const sorted = loans.map((l) => BigInt(l.outstanding)).sort((a, b) => (b > a ? 1 : b < a ? -1 : 0));
  const sumWhere = (s: Loan["status"]) => loans.filter((l) => l.status === s).reduce((a, l) => a + BigInt(l.outstanding), 0n);

  return {
    asOf: new Date(day * 86_400_000).toISOString().slice(0, 10),
    aprBps,
    book: book.toString(),
    sleeves,
    loans,
    concentration: { largestBorrowerBps: bps(sorted[0] ?? 0n), topFiveBps: bps(sorted.slice(0, 5).reduce((a, b) => a + b, 0n)) },
    delinquency: { watchBps: bps(sumWhere("watch")), dpd30Bps: bps(sumWhere("30dpd")) },
  };
}
