/*
 * This file is part of LibCSS.
 * Licensed under the MIT License,
 *		  http://www.opensource.org/licenses/mit-license.php
 */

#include <assert.h>
#include <string.h>

#include "bytecode/bytecode.h"
#include "bytecode/opcodes.h"
#include "parse/properties/properties.h"
#include "parse/properties/utils.h"

/**
 * Parse gap shorthand
 *
 * gap: <row-gap> <column-gap>?
 *
 * One value sets both gaps. Two set the row gap then the column gap, in
 * that order, so unlike the multi-value box shorthands the order matters
 * and there is no repetition rule beyond "one value means both".
 *
 * \param c	  Parsing context
 * \param vector  Vector of tokens to process
 * \param ctx	  Pointer to vector iteration context
 * \param result  Pointer to location to receive resulting style
 * \return CSS_OK on success,
 *	   CSS_NOMEM on memory exhaustion,
 *	   CSS_INVALID if the input is not valid
 *
 * Post condition: \a *ctx is updated with the next token to process
 *		   If the input is invalid, then \a *ctx remains unchanged.
 */
css_error css__parse_gap(css_language *c,
		const parserutils_vector *vector, int32_t *ctx,
		css_style *result)
{
	int32_t orig_ctx = *ctx;
	const css_token *token;
	uint16_t gap_val[2];
	css_fixed gap_length[2];
	uint32_t gap_unit[2];
	uint32_t gap_count = 0;
	bool match;
	css_error error;
	enum flag_value flag_value;

	token = parserutils_vector_peek(vector, *ctx);
	if (token == NULL)
		return CSS_INVALID;

	flag_value = get_css_flag_value(c, token);

	if (flag_value != FLAG_VALUE__NONE) {
		error = css_stylesheet_style_flag_value(result, flag_value,
				CSS_PROP_ROW_GAP);
		if (error != CSS_OK)
			return error;

		error = css_stylesheet_style_flag_value(result, flag_value,
				CSS_PROP_COLUMN_GAP);
		if (error == CSS_OK)
			parserutils_vector_iterate(vector, ctx);

		return error;
	}

	while (gap_count < 2) {
		token = parserutils_vector_peek(vector, *ctx);
		if (token == NULL) {
			break;
		}

		if ((token->type == CSS_TOKEN_IDENT) &&
		    (lwc_string_caseless_isequal(token->idata,
				c->strings[NORMAL], &match) == lwc_error_ok &&
				match)) {
			gap_val[gap_count] = ROW_GAP_NORMAL;
			parserutils_vector_iterate(vector, ctx);
		} else {
			gap_val[gap_count] = ROW_GAP_SET;

			error = css__parse_unit_specifier(c, vector, ctx,
					UNIT_PX, &gap_length[gap_count],
					&gap_unit[gap_count]);
			if (error != CSS_OK) {
				break;
			}

			if (((gap_unit[gap_count] & UNIT_LENGTH) == 0) ||
			    (gap_length[gap_count] < 0)) {
				*ctx = orig_ctx;
				return CSS_INVALID;
			}
		}

		gap_count++;

		consumeWhitespace(vector, ctx);
	}

	if (gap_count == 0) {
		*ctx = orig_ctx;
		return CSS_INVALID;
	}

#define GAP_APPEND(OP, NUM)							\
	error = css__stylesheet_style_appendOPV(result, (OP), 0,		\
			gap_val[(NUM)]);					\
	if (error != CSS_OK) {							\
		*ctx = orig_ctx;						\
		return error;							\
	}									\
	if (gap_val[(NUM)] == ROW_GAP_SET) {					\
		error = css__stylesheet_style_vappend(result, 2,		\
				gap_length[(NUM)], gap_unit[(NUM)]);		\
		if (error != CSS_OK) {						\
			*ctx = orig_ctx;					\
			return error;						\
		}								\
	}

	GAP_APPEND(CSS_PROP_ROW_GAP, 0);
	GAP_APPEND(CSS_PROP_COLUMN_GAP, (gap_count == 1) ? 0 : 1);

#undef GAP_APPEND

	return CSS_OK;
}
