import { money, tipFor } from './calc.js';

const bill = document.getElementById('bill');

function update() {
  const percent = Number(document.querySelector('input[name="tip"]:checked').value);
  const { tip, total } = tipFor(Number(bill.value) || 0, percent);
  document.getElementById('tip').textContent = money(tip);
  document.getElementById('total').textContent = money(total);
}

document.querySelector('.calc').addEventListener('input', update);
update();
