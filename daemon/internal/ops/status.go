package ops

// StatusResult is the `status` op's reply, key for key what the app reads.
type StatusResult struct {
	WgUp   bool `json:"wgUp"`
	TunUp  bool `json:"tunUp"`
	OvpnUp bool `json:"ovpnUp"`
}

// Status reads the kernel's interface table (world-readable; no lock, no spawn).
func Status(e *Env) StatusResult {
	return StatusResult{
		WgUp:   linkExists(e, wgIface),
		TunUp:  linkExists(e, tunIface),
		OvpnUp: linkExists(e, ovpnIface),
	}
}
