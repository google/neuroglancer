//
// Copyright (C) 2010  Aleksandar Zlateski <zlateski@mit.edu>
// ----------------------------------------------------------
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU General Public License for more details.
//
// You should have received a copy of the GNU General Public License
// along with this program.  If not, see <http://www.gnu.org/licenses/>.
//

#ifndef ZI_SYSTEM_DETAIL_LINUX_ERRNO_CODE_HPP
#define ZI_SYSTEM_DETAIL_LINUX_ERRNO_CODE_HPP 1

#include <zi/config/config.hpp>

#if defined( ZI_OS_LINUX )

namespace zi {
namespace system {
namespace linux_errno {

enum linux_errno_type
{
    advertise_error           = EADV,
    bad_exchange              = EBADE,
    bad_file_number           = EBADFD,
    bad_font_format           = EBFONT,
    bad_request_code          = EBADRQC,
    bad_request_descriptor    = EBADR,
    bad_slot                  = EBADSLT,
    channel_range             = ECHRNG,
    communication_error       = ECOMM,
    dot_dot_error             = EDOTDOT,
    exchange_full             = EXFULL,
    host_down                 = EHOSTDOWN,
    is_named_file_type        = EISNAM,
    key_expired               = EKEYEXPIRED,
    key_rejected              = EKEYREJECTED,
    key_revoked               = EKEYREVOKED,
    level2_halt               = EL2HLT,
    level2_no_syncronized     = EL2NSYNC,
    level3_halt               = EL3HLT,
    level3_reset              = EL3RST,
    link_range                = ELNRNG,
    medium_type               = EMEDIUMTYPE,
    no_anode                  = ENOANO,
    no_block_device           = ENOTBLK,
    no_csi                    = ENOCSI,
    no_key                    = ENOKEY,
    no_medium                 = ENOMEDIUM,
    no_network                = ENONET,
    no_package                = ENOPKG,
    not_avail                 = ENAVAIL,
    not_named_file_type       = ENOTNAM,
    not_recoverable           = ENOTRECOVERABLE,
    not_unique                = ENOTUNIQ,
    owner_dead                = EOWNERDEAD,
    protocol_no_supported     = EPFNOSUPPORT,
    remote_address_changed    = EREMCHG,
    remote_io_error           = EREMOTEIO,
    remote_object             = EREMOTE,
    restart_needed            = ERESTART,
    shared_library_access     = ELIBACC,
    shared_library_bad        = ELIBBAD,
    shared_library_execute    = ELIBEXEC,
    shared_library_max_       = ELIBMAX,
    shared_library_section    = ELIBSCN,
    shutdown                  = ESHUTDOWN,
    socket_type_not_supported = ESOCKTNOSUPPORT,
    srmount_error             = ESRMNT,
    stream_pipe_error         = ESTRPIPE,
    too_many_references       = ETOOMANYREFS,
    too_many_users            = EUSERS,
    unattached                = EUNATCH,
    unclean                   = EUCLEAN
};

} // namespace linux_errno
} // namespace system
} // namespace zi

#endif // defined( ZI_OS_LINUX )

#endif
