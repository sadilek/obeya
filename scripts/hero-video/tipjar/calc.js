/** Tip and total for a bill, in cents rounded to the cent. */
export function tipFor(bill, percent) {
  const tip = Math.round(bill * percent) / 100;
  return { tip, total: Math.round((bill + tip) * 100) / 100 };
}

export const money = (n) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
