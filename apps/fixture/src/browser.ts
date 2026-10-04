/**
 * Browser-only code compiled by TypeScript, with no framework or external assets.
 * Synthetic identity selection avoids implying real login. Text is rendered with
 * textContent, not innerHTML, so an API response cannot insert executable markup.
 */
const form = document.querySelector<HTMLFormElement>('#checkout');
const status = document.querySelector<HTMLParagraphElement>('#status');
if (!form || !status) throw new Error('Checkout controls are missing');
const checkoutForm = form;
const checkoutStatus = status;

checkoutForm.addEventListener('submit', async (event) => {
  event.preventDefault(); // Keep the page open while the API request is pending.
  const fields = new FormData(checkoutForm);
  checkoutStatus.textContent = 'Processing…';
  try {
    const configuration = (await fetch('/fixture-config').then((response) =>
      response.json(),
    )) as { mode: string };
    const response = await fetch('/api/orders', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer fixture-${fields.get('user')}`,
      },
      body: JSON.stringify({
        address: fields.get('address'),
        quantity: Number(fields.get('quantity')),
      }),
    });
    const result = (await response.json()) as { id?: string; error?: string };
    // Intentional UI defect: validation errors never replace the pending message.
    if (configuration.mode === 'checkout-stuck' && !response.ok) return;
    checkoutStatus.textContent = response.ok
      ? `Order placed: ${result.id}`
      : (result.error ?? 'Checkout failed');
  } catch {
    checkoutStatus.textContent = 'Could not reach checkout. Try again.';
  }
});
