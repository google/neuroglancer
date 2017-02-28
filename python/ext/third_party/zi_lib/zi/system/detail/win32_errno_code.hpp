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

#ifndef ZI_SYSTEM_DETAIL_WIN32_ERRNO_CODE_HPP
#define ZI_SYSTEM_DETAIL_WIN32_ERRNO_CODE_HPP 1

#include <zi/config/config.hpp>

#if defined( ZI_OS_WINDOWS )

namespace zi {
namespace system {
namespace win32_errno {

enum win32_errno_type
{
    no_error                = 0,
    invalid_function        = 1,
    file_not_found          = 2,
    path_not_found          = 3,
    too_many_open_files     = 4,
    access_denied           = 5,
    invalid_handle          = 6,
    arena_trashed           = 7,
    not_enough_memory       = 8,
    invalid_block           = 9,

    bad_environment         = 10,
    bad_format              = 11,
    invalid_access          = 12,
    invalid_data            = 13,
    out_of_memory           = 14,
    invalid_drive           = 15,
    current_directory       = 16,
    not_same_device         = 17,
    no_more_files           = 18,
    write_protect           = 19,

    bad_unit                = 20,
    not_ready               = 21,
    bad_command             = 22,
    crc                     = 23,
    bad_length              = 24,
    seek                    = 25,
    not_dos_disk            = 26,
    sector_not_found        = 27,
    out_of_paper            = 28,
    write_fault             = 29,

    read_fault              = 30,
    gen_failure             = 31,
    sharing_violation       = 32,
    lock_violation          = 33,
    wrong_disk              = 34,
    //                      = 35,
    sharing_buffer_exceeded = 36,
    //                      = 37,
    handle_eof              = 38,
    handle_disk_full        = 39,

    not_supported           = 50,
    rem_not_list            = 51,
    dup_name                = 52,
    bad_net_path            = 53,
    network_busy            = 54,
    bad_device              = 55,
    too_many_cmds           = 56,
    adapter_hadrware_error  = 57,
    bad_network_response    = 58,
    unexpected_network_error= 59,

    // ...

    file_exists             = 80,
    cannot_make             = 82,

    broken_pipe             = 109,
    open_failed             = 110,
    buffer_overflow         = 111,
    disk_full               = 112,

    lock_failed             = 167,
    busy                    = 170,
    cancel_violation        = 173,
    already_exists          = 183,
};

} // namespace win32_errno
} // namespace system
} // namespace zi

#endif // defined( ZI_OS_WINDOWS )

#endif
