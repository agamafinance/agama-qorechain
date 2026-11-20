"""Expands a FIPS 204 ML-DSA-44 public key (1,312 bytes, hex on argv[1]) into the form ZKNox's Solidity verifier
reads: the matrix A and t1 * 2^d in its NTT domain, ABI-encoded. Public input only, no secret.

Run with the reference implementation vendored in contracts/lib/ETHDILITHIUM/pythonref (see expand-mldsa44.sh)."""
import sys
from eth_abi import encode
from dilithium_py.dilithium.default_parameters import Dilithium2 as D

pk = bytes.fromhex(sys.argv[1].removeprefix("0x"))
assert len(pk) == 1312, "ML-DSA-44 public keys are 1,312 bytes"
rho, t1 = D._unpack_pk(pk)
A_hat = D._expand_matrix_from_seed(rho)
tr = D._h(pk, 64)
t1 = t1.scale(1 << D.d).to_ntt()
a = A_hat.compact_256(32)
t = [row[0] for row in t1.compact_256(32)]
out = encode(["bytes", "bytes", "bytes"], [encode(["uint256[][][]"], [a]), tr, encode(["uint256[][]"], [t])])
print("0x" + out.hex())
