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

#ifndef ZI_SYSTEM_DETAIL_CERRNO_CODE_HPP
#define ZI_SYSTEM_DETAIL_CERRNO_CODE_HPP 1

namespace zi {
namespace system {
namespace cerrno {

enum cerrno_type
{
    success                         = 0,
    address_family_not_supported    = 9901,
    address_in_use                  = 9902,
    address_not_available           = 9903,
    already_connected               = 9904,
    bad_message                     = 9905,
    connection_aborted              = 9906,
    connection_already_in_progress  = 9907,
    connection_refused              = 9908,
    connection_reset                = 9909,

    destination_address_required    = 9910,
    host_unreachable                = 9911,
    identifier_removed              = 9912,
    message_size                    = 9913,
    network_down                    = 9914,
    network_reset                   = 9915,
    network_unreachable             = 9916,
    no_buffer_space                 = 9917,
    no_link                         = 9918,
    no_message_available            = 9919,

    no_message                      = 9920,
    no_protocol_option              = 9921,
    no_stream_resources             = 9922,
    not_a_socket                    = 9923,
    not_a_stream                    = 9924,
    not_connected                   = 9925,
    not_supported                   = 9926,
    operation_canceled              = 9927,
    operation_in_progress           = 9928,
    operation_not_supported         = 9929,

    operation_would_block           = 9930,
    owner_dead                      = 9931,
    protocol_error                  = 9932,
    protocol_not_supported          = 9933,
    state_not_recoverable           = 9934,
    stream_timeout                  = 9935,
    text_file_busy                  = 9936,
    // not_used                     = 9937,
    timed_out                       = 9938,
    too_many_synbolic_link_levels   = 9939,

    value_too_large                 = 9940,
    wrong_protocol_type             = 9941,
    function_not_supported          = 9942,
    invalid_argument                = 9943,
    result_out_of_range             = 9944,
    illegal_byte_sequence           = 9945,
    argument_list_too_long          = 9946,
    argument_out_of_domain          = 9947,
    bad_address                     = 9948,
    bad_file_descriptor             = 9949,

    broken_pipe                     = 9950,
    cross_device_link               = 9951,
    device_or_resource_busy         = 9952,
    directory_not_empty             = 9953,
    executable_format_error         = 9954,
    file_exists                     = 9955,
    file_too_large                  = 9956,
    filename_too_long               = 9957,
    bad_io_control_operation        = 9958,
    interrupted                     = 9959,

    invalid_seek                    = 9960,
    io_error                        = 9961,
    is_a_directory                  = 9962,
    no_child_process                = 9963,
    no_lock_available               = 9964,
    no_space_on_device              = 9965,
    no_such_device_or_address       = 9966,
    no_such_device                  = 9967,
    no_such_file_or_directory       = 9968,
    no_such_process                 = 9969,

    not_a_directory                 = 9970,
    not_enough_memory               = 9971,
    operation_not_permitted         = 9972,
    permission_denied               = 9973,
    read_only_file_system           = 9974,
    resource_deadlock_would_occur   = 9975,
    resource_unavailable_try_again  = 9976,
    too_many_files_open_in_system   = 9977,
    too_many_files_open             = 9978,
    too_many_links                  = 9979

};

} // namespace cerrno
} // namespace system
} // namespace zi

#endif
