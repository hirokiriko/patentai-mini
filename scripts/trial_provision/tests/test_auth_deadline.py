"""Offline authentication creation-window and final-send contracts."""

from copy import deepcopy
import unittest

from scripts.trial_guard.lifecycle import Denied
from scripts.trial_provision.auth import (
    AuthDenied, EasyAuthAdapter, EXPIRY, GraphAdapter, build_auth_operations,
)
from scripts.trial_provision.cli import _window_guard
from scripts.trial_provision.journal import CountedControlHttp
from scripts.trial_provision.tests.test_auth import (
    APP, CLIENT, END, KEY, SECRET, T0, Clock, Credential, Wire, all_receipts,
    binding, easy_binding, operations, receipts, response,
)


class AuthDeadlineTests(unittest.TestCase):
    def test_saved_plan_with_wide_creation_deadline_is_refused_inside_window(self):
        guard = _window_guard({"windows": {"owner_input": {"start": T0, "end": END}}})
        for index, op in enumerate(operations(), 1):
            op.update(id="E" + str(index), deadline=EXPIRY)
            with self.subTest(operation=op['id']):
                with self.assertRaises(Denied): guard(op, Clock().utc())

    def test_expired_owner_window_cannot_create_undeliverable_e4_credential(self):
        clock = Clock()
        clock.value += 61
        clock.mono += 61
        op = operations()[3]
        op.update(id="E4", deadline=EXPIRY)
        password = op["body"]["passwordCredential"]
        wire = Wire([
            response(200, dict(password, keyId=KEY, secretText=SECRET)),
            response(200, {"id": APP, "passwordCredentials": [dict(password, keyId=KEY)]}),
        ])
        graph = GraphAdapter(binding(), Credential(), wire, clock)
        easy = EasyAuthAdapter(easy_binding(), Credential(), wire, lambda: {}, clock)
        guard = _window_guard({"windows": {"owner_input": {"start": T0, "end": END}}})
        intents, checkpoints, delivery = [], [], []

        def before_send(operation):
            guard(operation, clock.utc())
            intents.append(operation["id"])

        def deliver(secret, receipt):
            prior = all_receipts()
            prior.pop("addPassword")
            prior["E4"] = receipt
            delivery_op = build_auth_operations(easy_binding(), prior, END, "trial-app")[0]
            delivery.append("entered")
            try:
                return easy.deliver(delivery_op, secret, receipt, before_send,
                                    checkpoints.append, prior["trial-app"])
            except AuthDenied:
                delivery.append("expired")
                raise

        result = graph.execute(op, receipts(), before_send, checkpoints.append, deliver)
        self.assertEqual([], wire.calls)
        self.assertEqual([], intents)
        self.assertEqual([], delivery)
        self.assertFalse(result["write_terminal"])
        self.assertFalse(result["terminal"])

    def test_auth_window_start_and_end_fence_new_writes_but_allow_scoped_cleanup(self):
        guard = _window_guard({"windows": {"owner_input": {"start": T0, "end": END}}})
        graph_ops = list(operations())
        for index, op in enumerate(graph_ops, 1):
            op["id"] = "E" + str(index)
        auth_ops = build_auth_operations(easy_binding(), all_receipts(), END, "trial-app")
        for op in graph_ops + auth_ops:
            for offset in (-1, 60, 61):
                with self.subTest(operation=op["id"], offset=offset):
                    clock = Clock()
                    clock.value += offset
                    with self.assertRaises(Denied):
                        guard(op, clock.utc())
                    cleanup = deepcopy(op)
                    cleanup["id"] = "cleanup_" + op["id"]
                    cleanup["kind"] = "cleanup:" + op["kind"]
                    if cleanup["expected"].get("auth_action"):
                        cleanup["expected"]["auth_action"] = "cleanup:" + cleanup["expected"]["auth_action"]
                    guard(cleanup, clock.utc())
            guard(op, Clock().utc())

    def test_absolute_auth_deadline_rechecked_after_budget_fsync_clock_jump(self):
        clock = Clock()
        clock.value += 45
        clock.mono += 45
        op = operations()[0]
        op["id"] = "E1"
        wire = Wire([response(201, dict(op["body"], id=APP, appId=CLIENT))])
        charged, intents = [], []

        class ForwardJumpBudget:
            def consume(self, kind, limit):
                charged.append(kind)
                # Wall time crosses the fixed deadline during durable debit.
                # Monotonic remains unchanged, so Deadline.remaining() alone
                # cannot detect this absolute permission-window expiration.
                clock.value += 20

        graph = GraphAdapter(binding(), Credential(),
                             CountedControlHttp(wire, ForwardJumpBudget()), clock)
        guard = _window_guard({"windows": {"owner_input": {"start": T0, "end": END}}})

        def before_send(operation):
            guard(operation, clock.utc())
            intents.append(operation["id"])

        result = graph.execute(op, {}, before_send, lambda receipt: None)
        self.assertEqual(["E1"], intents)
        self.assertEqual(["owner_arm"], charged)
        self.assertEqual([], wire.calls)
        self.assertFalse(result["write_terminal"])
        self.assertFalse(result["terminal"])


if __name__ == "__main__":
    unittest.main()
