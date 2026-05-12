"""
Asterdex Futures API client — EIP-712 signed requests.
Requires: pip install eth-account requests python-dotenv
"""

import math
import os
import time
from urllib.parse import urlencode

import requests
from dotenv import load_dotenv
from eth_account import Account
from eth_account.messages import encode_typed_data

load_dotenv()

BASE_URL = os.getenv("BASE_URL", "https://fapi.asterdex.com")
USER_ADDRESS = os.getenv("USER_ADDRESS")
SIGNER_ADDRESS = os.getenv("SIGNER_ADDRESS")
SIGNER_PRIVATE_KEY = os.getenv("SIGNER_PRIVATE_KEY")

# EIP-712 domain for Asterdex
EIP712_DOMAIN = {
    "name": "AsterSignTransaction",
    "version": "1",
    "chainId": 1666,
    "verifyingContract": "0x0000000000000000000000000000000000000000",
}


def _nonce() -> int:
    return math.trunc(time.time() * 1_000_000)


def _sign(params: dict) -> str:
    """Build EIP-712 signature over URL-encoded param string."""
    payload = urlencode(params)
    encoded = encode_typed_data(
        domain_data=EIP712_DOMAIN,
        message_types={"Message": [{"name": "msg", "type": "string"}]},
        message_data={"msg": payload},
    )
    signed = Account.sign_message(encoded, private_key=SIGNER_PRIVATE_KEY)
    return signed.signature.hex()


def _auth_params(extra: dict | None = None) -> dict:
    params = {
        "user": USER_ADDRESS,
        "signer": SIGNER_ADDRESS,
        "nonce": _nonce(),
    }
    if extra:
        params.update(extra)
    params["signature"] = _sign(params)
    return params


def get_balance() -> list[dict]:
    """GET /fapi/v3/balance — returns list of asset balances."""
    params = _auth_params()
    r = requests.get(f"{BASE_URL}/fapi/v3/balance", params=params, timeout=10)
    r.raise_for_status()
    return r.json()


def place_order(
    symbol: str,
    side: str,          # "BUY" | "SELL"
    order_type: str,    # "MARKET" | "LIMIT" | ...
    quantity: float,
    price: float | None = None,
    time_in_force: str | None = None,
    position_side: str = "BOTH",
) -> dict:
    """POST /fapi/v3/order — open a position."""
    extra: dict = {
        "symbol": symbol,
        "side": side,
        "type": order_type,
        "quantity": quantity,
        "positionSide": position_side,
    }
    if price is not None:
        extra["price"] = price
    if time_in_force is not None:
        extra["timeInForce"] = time_in_force

    params = _auth_params(extra)
    r = requests.post(
        f"{BASE_URL}/fapi/v3/order",
        data=params,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        timeout=10,
    )
    r.raise_for_status()
    return r.json()


def main():
    print("=== Asterdex API Demo ===\n")

    # 1. Balance
    print("--- Balance ---")
    balances = get_balance()
    for b in balances:
        print(f"  {b['asset']}: balance={b['balance']}  available={b['availableBalance']}")

    print()

    # 2. Open a MARKET BUY position — 0.001 BTC
    print("--- Place Order ---")
    order = place_order(
        symbol="BTCUSDT",
        side="BUY",
        order_type="MARKET",
        quantity=0.001,
    )
    print(f"  orderId={order.get('orderId')}  status={order.get('status')}  "
          f"symbol={order.get('symbol')}  executedQty={order.get('executedQty')}")


if __name__ == "__main__":
    main()
