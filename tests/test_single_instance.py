"""The single-instance guard is the fix for two servers racing for port 8000,
so it is worth proving rather than assuming."""

from __future__ import annotations

import sys
import threading
import time

import pytest

pytestmark = pytest.mark.skipif(sys.platform != "win32", reason="Windows named objects")

from app.single_instance import SingleInstance


def test_first_instance_is_not_flagged_as_running():
    guard = SingleInstance("RECONtest-first")
    try:
        assert guard.already_running is False
    finally:
        guard.stop()


def test_second_instance_sees_the_first():
    first = SingleInstance("RECONtest-second")
    try:
        assert first.already_running is False
        second = SingleInstance("RECONtest-second")
        try:
            assert second.already_running is True
        finally:
            second.stop()
    finally:
        first.stop()


def test_the_name_is_released_when_the_first_instance_exits():
    """Otherwise a crash would lock the app out until reboot."""
    first = SingleInstance("RECONtest-release")
    assert first.already_running is False
    first.stop()

    second = SingleInstance("RECONtest-release")
    try:
        assert second.already_running is False
    finally:
        second.stop()


def test_second_launch_signals_the_first_to_show_itself():
    shown = threading.Event()
    first = SingleInstance("RECONtest-signal")
    try:
        first.listen(shown.set)
        time.sleep(0.2)  # let the wait thread arm

        second = SingleInstance("RECONtest-signal")
        try:
            assert second.already_running is True
            assert second.signal_existing() is True
        finally:
            second.stop()

        assert shown.wait(timeout=5), "the running instance was never asked to show its window"
    finally:
        first.stop()


def test_signalling_with_nobody_listening_is_harmless():
    """A launch that loses the race to a copy already shutting down should
    not raise -- it just means there is nothing to surface."""
    lonely = SingleInstance("RECONtest-nolistener")
    try:
        assert lonely.signal_existing() is False
    finally:
        lonely.stop()
